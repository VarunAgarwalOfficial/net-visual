.PHONY: dev build test check lint

# Serves the page at http://localhost:5173.
dev:
	npm run dev

# Builds the static site into dist/ from the committed netsim.wasm.
build:
	npm run build

test:
	npm test

# A clean install, the build and the tests. CI runs this, then make lint.
check:
	npm ci
	$(MAKE) build test

lint:
	npm run lint
