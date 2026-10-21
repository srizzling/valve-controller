# Applied from your machine only: CI cannot reach the homelab. Needs ../.env (make setup in ..) and ../backend.hcl.
TF ?= terraform

-include ../.env
.EXPORT_ALL_VARIABLES:

.PHONY: init plan apply fmt validate

init:
	$(TF) init -backend-config=../backend.hcl

plan:
	$(TF) plan

apply:
	$(TF) apply

fmt:
	$(TF) fmt

validate:
	$(TF) validate
