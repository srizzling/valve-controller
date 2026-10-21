# Terraform needs the Worker bundle to exist before it plans.
TF ?= terraform

BUCKET ?= valve-controller-tfstate

.PHONY: build bootstrap init plan apply fmt validate

build:
	cd ../worker && npm ci && npx wrangler deploy --dry-run --outdir build

# One time: create the private bucket that holds the state (needs CLOUDFLARE_API_TOKEN with R2 edit, or `wrangler login`).
bootstrap:
	cd ../worker && npx wrangler r2 bucket create $(BUCKET)

# Needs backend.hcl and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY set to your R2 token's keys.
init:
	$(TF) init -backend-config=backend.hcl

plan: build
	$(TF) plan

apply: build
	$(TF) apply

fmt:
	$(TF) fmt

validate:
	$(TF) validate
