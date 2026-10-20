# Terraform needs the Worker bundle to exist before it plans.
TF ?= terraform

.PHONY: build init plan apply fmt validate

build:
	cd ../worker && npm ci && npx wrangler deploy --dry-run --outdir build

init:
	$(TF) init

plan: build
	$(TF) plan

apply: build
	$(TF) apply

fmt:
	$(TF) fmt

validate:
	$(TF) validate
