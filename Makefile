.PHONY: dev build test typecheck clean bump-patch bump-minor

dev:
	npx vite build --watch --mode development

build:
	npx tsc --noEmit && npx vite build && cp -r icons dist/icons

test:
	npx vitest run

typecheck:
	npx tsc --noEmit

clean:
	rm -rf dist

bump-patch:
	npm version patch --no-git-tag-version
	node -e "const fs=require('fs'),p=require('./package.json'),m=JSON.parse(fs.readFileSync('manifest.json','utf8'));m.version=p.version;fs.writeFileSync('manifest.json',JSON.stringify(m,null,2)+'\n')"

bump-minor:
	npm version minor --no-git-tag-version
	node -e "const fs=require('fs'),p=require('./package.json'),m=JSON.parse(fs.readFileSync('manifest.json','utf8'));m.version=p.version;fs.writeFileSync('manifest.json',JSON.stringify(m,null,2)+'\n')"
