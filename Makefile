GO ?= go
PYTHON ?= python3

.PHONY: build test lint release js-sdk dashboard archives android-release test-server test-js test-swift test-android check-clean

build: archives
	npm run build --workspace birdwatch-ui
	mkdir -p build
	CGO_ENABLED=0 $(GO) build -o build/birdwatch ./cmd/birdwatch

node_modules/.birdwatch-installed: package-lock.json package.json sdk/package.json sdks/exact/package.json sdks/react-native/package.json ui/package.json .npmrc
	npm ci
	touch $@

js-sdk: node_modules/.birdwatch-installed
	npm run build --workspace @birdwatch/sdk
	node sdks/build.mjs

android-release:
	cd sdks/android && ./gradlew assembleRelease

archives: js-sdk android-release
	node sdks/artifacts.mjs --pack

dashboard: node_modules/.birdwatch-installed
	npm run build --workspace birdwatch-ui

test: build
	$(MAKE) test-server test-js test-swift test-android

test-server:
	BIRDWATCH_REFERENCE=python BIRDWATCH_SERVER_CMD="$(PYTHON) server.py" $(GO) test -count=1 ./...

test-js: js-sdk
	npm test --workspace @birdwatch/sdk
	node --test sdks/test/*.test.mjs
	$(MAKE) dashboard

test-swift:
	cd sdks/swift && swift build && swift test

test-android:
	cd sdks/android && ./gradlew assemble

lint: js-sdk
	$(GO) vet ./...
	npm exec -- tsc --project sdk/test/tsconfig.json
	git diff --check

check-clean:
	git diff --exit-code HEAD --

release:
	@echo "Release packaging is planned in R2." >&2
	@exit 1
