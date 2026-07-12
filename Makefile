.PHONY: dev build test test-e2e typecheck clean demo package verify-version \
	bump-patch bump-minor bump-major release-patch release-minor release-major

dev:
	npx vite build --watch --mode development

build:
	npx tsc --noEmit && npx vite build && cp -r icons dist/icons

test:
	npx vitest run

test-e2e: build
	npx playwright test

typecheck:
	npx tsc --noEmit

demo:
	npx vite --config demo/vite.config.ts

clean:
	rm -rf dist build

verify-version:
	@node -e "const p=require('./package.json'),m=require('./manifest.json');if(p.version!==m.version){console.error('Version mismatch: package.json='+p.version+' manifest.json='+m.version);process.exit(1)}console.log('Version '+p.version+' (package.json and manifest.json in sync)')"

# Installable zip at build/deskcheck-vX.Y.Z.zip (unzips to a deskcheck/ folder
# ready for chrome://extensions "Load unpacked").
package: verify-version build
	rm -rf build
	mkdir -p build
	cp -R dist build/deskcheck
	VERSION=$$(node -p "require('./package.json').version"); \
	cd build && zip -rq "deskcheck-v$$VERSION.zip" deskcheck
	@ls -lh build/*.zip

bump-patch bump-minor bump-major: bump-%:
	npm version $* --no-git-tag-version
	node -e "const fs=require('fs'),p=require('./package.json'),m=JSON.parse(fs.readFileSync('manifest.json','utf8'));m.version=p.version;fs.writeFileSync('manifest.json',JSON.stringify(m,null,2)+'\n')"

# Full release: guard checks, bump, changelog, commit, tag. Pushing the tag
# triggers .github/workflows/release.yml which publishes the GitHub Release.
release-patch release-minor release-major: release-%:
	./scripts/release.sh $*
