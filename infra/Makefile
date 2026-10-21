# Terraform needs the Worker bundle to exist before it plans.
TF ?= terraform

.PHONY: build setup init plan apply fmt validate

build:
	cd ../worker && npm ci && npx wrangler deploy --dry-run --outdir build

# One time: creates the private state bucket, R2 keys limited to it, backend.hcl, .env and terraform.tfvars.
# Needs CLOUDFLARE_API_TOKEN (see the top of setup.mjs). Safe to run again.
setup:
	node setup.mjs

# Every secret comes from .env (see .env.example); `make setup` adds the R2 keys to it.
-include .env
.EXPORT_ALL_VARIABLES:

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
