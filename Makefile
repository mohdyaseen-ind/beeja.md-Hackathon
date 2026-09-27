.PHONY: setup run test clean

setup:
	@echo "Setting up environment..."
	npm install
	cd web && npm install
	npm run build

run:
	@echo "Starting AI Harness..."
	AI_API_KEY="$(AI_API_KEY)" CODEX_BIN="$(CURDIR)/node_modules/.bin/codex" npm start

test:
	@echo "Running tests..."
	npm run typecheck

clean:
	@echo "Cleaning up..."
	rm -rf node_modules
	rm -rf web/node_modules
	rm -rf web/dist
