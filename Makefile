.PHONY: check lint

check:
	npm ci
	npm run build
	npm test

lint:
	npm run lint
