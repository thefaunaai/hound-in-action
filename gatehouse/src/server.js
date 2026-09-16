const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const createPuzzle = require("node-puzzle");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const SES_REGION = String(process.env.SES_REGION || "").trim();
const SES_ENABLED = Boolean(SES_REGION);
const MAIL_FROM = String(process.env.MAIL_FROM || "").trim();
const ALLOWED_EMAIL = String(process.env.ALLOWED_EMAIL || "").trim().toLowerCase();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("base64url");
const CODE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_IMAGE_PATH = path.join(__dirname, "..", "public", "assets", "challenge.jpg");
const STATES = Object.freeze({
    ANONYMOUS: "anonymous",
    CODE_SENT: "code_sent",
    CODE_VERIFIED: "code_verified",
    AUTHENTICATED: "authenticated",
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
    "/vendor",
    express.static(path.join(__dirname, "..", "node_modules/slider-captcha-js/dist"))
);

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax" },
    })
);

// --- startup: validate mail configuration ---
if (SES_ENABLED && !MAIL_FROM) {
    throw new Error("MAIL_FROM is required when SES_REGION is set");
}
if (SES_ENABLED && !ALLOWED_EMAIL) {
    throw new Error("ALLOWED_EMAIL is required when SES_REGION is set");
}
if (!fs.existsSync(CHALLENGE_IMAGE_PATH)) {
    throw new Error(`Challenge image missing: ${CHALLENGE_IMAGE_PATH}`);
}
const sesClient = SES_ENABLED ? new SESv2Client({ region: SES_REGION }) : null;
console.log(`Gatehouse mail: ${SES_ENABLED ? "ses" : "stdout"}`);

// --- helpers ---
app.use((req, res, next) => {
    if (!req.session.state) req.session.state = STATES.ANONYMOUS;
    next();
});

function hash(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function resetLogin(sessionData) {
    Object.assign(sessionData, {
        state: STATES.ANONYMOUS,
        email: null,
        codeHash: null,
        codeExpiresAt: null,
        codeAttempts: 0,
        challenge: null,
    });
}

function renderLoginStep(req, res, error = null, status = 200) {
    if (req.session.state === STATES.CODE_SENT) {
        return res.status(status).render("code", { error, email: req.session.email });
    }
    if (req.session.state === STATES.CODE_VERIFIED) {
        if (!req.session.challenge) {
            resetLogin(req.session);
            return res.status(400).render("login", { error: "Start again." });
        }
        return res.status(status).render("challenge", {
            error,
            challenge: {
                id: req.session.challenge.id,
                bgUrl: req.session.challenge.bgUrl,
                puzzleUrl: req.session.challenge.puzzleUrl,
            },
        });
    }
    return res.status(status).render("login", { error });
}

async function sendCode(email, code) {
    if (!SES_ENABLED) {
        console.log(`GATEHOUSE_EMAIL_CODE email=${email} code=${code}`);
        return;
    }
    console.log(`GATEHOUSE_EMAIL_SEND_START to=${email}`);
    const info = await sesClient.send(
        new SendEmailCommand({
            FromEmailAddress: MAIL_FROM,
            Destination: { ToAddresses: [email] },
            Content: {
                Simple: {
                    Subject: { Data: "Your Gatehouse verification code" },
                    Body: {
                        Text: {
                            Data: `Your Gatehouse verification code is ${code}. It expires in 10 minutes.`,
                        },
                    },
                },
            },
        })
    );
    console.log(`GATEHOUSE_EMAIL_SEND_ACCEPTED to=${email} messageId=${info.MessageId || "unknown"}`);
}

async function issueChallenge(sessionData) {
    const puzzle = await createPuzzle(CHALLENGE_IMAGE_PATH, {
        bgWidth: 320,
        bgHeight: 160,
        width: 60,
        height: 60,
        margin: 12,
        fillColor: "rgba(0,0,0,0.18)",
        borderColor: "rgba(255,255,255,0.45)",
        borderWidth: 1,
        format: "png",
        bgFormat: "jpeg",
    });
    sessionData.challenge = {
        id: crypto.randomBytes(12).toString("hex"),
        targetX: puzzle.x,
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
        attempts: 0,
        bgUrl: dataUrl("image/jpeg", puzzle.bg),
        puzzleUrl: dataUrl("image/png", puzzle.puzzle),
    };
}

function verifyChallengeAttempt(sessionData, body) {
    const challenge = sessionData.challenge;
    if (!challenge || body.challengeId !== challenge.id) return "challenge did not match";
    if (challenge.expiresAt <= Date.now()) return "challenge expired";
    challenge.attempts += 1;
    if (challenge.attempts > 5) return "too many attempts";
    const x = Number(body.x);
    const duration = Number(body.duration);
    if (!Number.isFinite(x) || !Number.isFinite(duration)) return "invalid attempt";
    if (duration < 300 || !Array.isArray(body.trail) || body.trail.length < 2) {
        return "attempt was not interactive";
    }
    if (Math.abs(x - challenge.targetX) > 7) return "puzzle was not completed";
    return null;
}

function dataUrl(mime, buffer) {
    return `data:${mime};base64,${buffer.toString("base64")}`;
}

// --- public routes ---
app.get("/health", (req, res) => res.type("text").send("ok"));

app.get("/", (req, res) => {
    if (req.session.state === STATES.AUTHENTICATED) return res.redirect("/app");
    return res.redirect("/login");
});

app.get("/login", (req, res) => {
    if (req.session.state === STATES.AUTHENTICATED) return res.redirect("/app");
    return renderLoginStep(req, res);
});

app.post("/login", async (req, res) => {
    const email = String(req.body.email || "").trim();
    if (!email) {
        return res.status(400).render("login", { error: "Enter an email address." });
    }
    if (ALLOWED_EMAIL && email.toLowerCase() !== ALLOWED_EMAIL) {
        return res.status(403).render("login", { error: "That email address is not allowed." });
    }
    const code = String(crypto.randomInt(100000, 999999));
    try {
        await sendCode(email, code);
    } catch (error) {
        console.error(`GATEHOUSE_EMAIL_SEND_FAILED message=${error.message || error}`);
        return res.status(502).render("login", { error: "Could not send the code." });
    }
    Object.assign(req.session, {
        state: STATES.CODE_SENT,
        email,
        codeHash: hash(code),
        codeExpiresAt: Date.now() + CODE_TTL_MS,
        codeAttempts: 0,
        challenge: null,
    });
    res.redirect("/login");
});

app.post("/login/code", async (req, res) => {
    if (req.session.state !== STATES.CODE_SENT) {
        return renderLoginStep(req, res, "That login step is not ready yet.", 409);
    }
    const code = String(req.body.code || "").trim();
    req.session.codeAttempts += 1;
    if (!req.session.codeHash || req.session.codeExpiresAt <= Date.now()) {
        resetLogin(req.session);
        return renderLoginStep(req, res, "Code expired. Start again.", 400);
    }
    if (req.session.codeAttempts > 5) {
        resetLogin(req.session);
        return renderLoginStep(req, res, "Too many code attempts. Start again.", 400);
    }
    if (hash(code) !== req.session.codeHash) {
        return res.status(400).render("code", {
            error: "Code did not match.",
            email: req.session.email,
        });
    }
    Object.assign(req.session, { state: STATES.CODE_VERIFIED, codeHash: null, codeExpiresAt: null });
    try {
        await issueChallenge(req.session);
    } catch (error) {
        console.error(`GATEHOUSE_CHALLENGE_CREATE_FAILED message=${error.message || error}`);
        resetLogin(req.session);
        return res.status(500).render("login", { error: "Could not create the challenge." });
    }
    res.redirect("/login");
});

app.post("/login/challenge", (req, res) => {
    if (req.session.state !== STATES.CODE_VERIFIED) {
        return res.status(409).json({ ok: false, error: "wrong step" });
    }
    const error = verifyChallengeAttempt(req.session, req.body || {});
    if (error) {
        const trailPoints = Array.isArray(req.body?.trail) ? req.body.trail.length : "invalid";
        const delta = Math.round(Math.abs(Number(req.body?.x) - Number(req.session.challenge?.targetX)));
        console.warn(`GATEHOUSE_CHALLENGE_REJECTED reason=${JSON.stringify(error)} durationMs=${Number(req.body?.duration)} trailPoints=${trailPoints} coordinateDeltaPx=${delta}`);
        return res.status(400).json({ ok: false, error });
    }
    Object.assign(req.session, { state: STATES.AUTHENTICATED, challenge: null });
    res.json({ ok: true });
});

// --- authenticated routes (HTML) ---
app.get("/app", (req, res) => {
    if (req.session.state !== STATES.AUTHENTICATED) return res.redirect("/login");
    res.render("app");
});

app.use((req, res) => {
    res.status(404).type("text").send("not found");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Gatehouse listening on :${PORT}`);
});
