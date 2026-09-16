# Gatehouse

A small auth checkpoint target. It keeps the path intentionally plain:
email code, visual puzzle, protected page. Node only, around 250 lines.

## Auth Path

Email address, real email-code verification, server-verified puzzle
slider, protected page. The slider uses NASA's public-domain Blue
Marble image as its local source image.

## Requirements

- Docker (with `docker compose`)
- `make`
- `curl`

No Node or package install is required on your host.

## Run It

```sh
make up        # build and start the app
make reset     # wipe state, start fresh
make down      # stop and remove
```

Docker assigns an available host port and `make up` prints the URL. Use
`HOST_PORT=3101 make up` only when you need a fixed host port.

## Email Delivery

Without a local `.env`, Gatehouse prints verification codes to the
container logs. Cloud runs deliver through Amazon SES.

For an SES run, put these settings in `gatehouse/.env`:

```dotenv
SES_REGION=us-east-1
MAIL_FROM=gatehouse@example.com
ALLOWED_EMAIL=recipient@example.com
```

SES uses ambient AWS credentials. `MAIL_FROM` and `ALLOWED_EMAIL` are
required so Gatehouse only sends to the allowed inbox.

```sh
make up
```

Use the Gatehouse URL and `ALLOWED_EMAIL` as the test recipient. The
verification code must come from that account's real inbox.

For email debugging, watch the container logs:

```sh
docker compose logs -f gatehouse
```

The app logs `GATEHOUSE_EMAIL_SEND_START` before delivery and
`GATEHOUSE_EMAIL_SEND_ACCEPTED` after SES accepts the message. It does
not print verification codes in SES mode.

## EC2 Run

Use `infra/` for a temporary cloud run. Terraform deploys Gatehouse on a
disposable EC2 instance behind an HTTPS Application Load Balancer. The
load balancer accepts traffic only from the configured source CIDR, EC2
access uses SSM instead of SSH, and the instance role sends through an
existing SES identity.

Terraform state is local, gitignored, and disposable.
