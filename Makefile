# pi-cliproxyapi — dev / global mode toggle
#
# dev    — load the LOCAL working-tree source via .pi/extensions/cliproxyapi.ts
#          (default). The globally-installed npm copy stands down here (see the
#          mode guard in index.ts), so only your dev code runs.
# global — disable the local loader so the globally-installed published package
#          loads instead, letting you test exactly what users get.
#
# After switching, run /reload in pi (or restart pi) to apply.

LOADER   := .pi/extensions/cliproxyapi.ts
DISABLED := .pi/extensions/cliproxyapi.ts.disabled

.PHONY: help dev global status check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

dev: ## Load the local working-tree source in this repo (default)
	@if [ -f "$(DISABLED)" ]; then mv "$(DISABLED)" "$(LOADER)"; fi
	@echo "mode: DEV — local loader active. Run /reload in pi."

global: ## Use the globally-installed npm package instead
	@if [ -f "$(LOADER)" ]; then mv "$(LOADER)" "$(DISABLED)"; fi
	@echo "mode: GLOBAL — local loader disabled. Run /reload in pi."

status: ## Show the current mode
	@if [ -f "$(LOADER)" ]; then echo "mode: DEV (local loader present)"; \
	 else echo "mode: GLOBAL (local loader disabled)"; fi

check: ## Typecheck
	npx tsc --noEmit
