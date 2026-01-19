# Publishing Sapper to NPM

This guide explains how to publish Sapper to npm registry manually.

## Prerequisites

1. **npm account** - Create at [npmjs.com](https://npmjs.com)
2. **npm login** - Run `npm login` in terminal
3. **Package name available** - Check if "sapper" is available on npm

## Step-by-Step Publishing Process

### 1. Verify Package Configuration

Check `package.json` has correct information:
```json
{
  "name": "sapper",
  "version": "1.0.0",
  "main": "sapper.mjs",
  "bin": {
    "sapper": "./sapper.mjs"
  },
  "type": "module"
}
```

### 2. Make Executable

Ensure the main file is executable:
```bash
chmod +x sapper.mjs
```

### 3. Test Locally

Test the package locally before publishing:
```bash
npm link
sapper --version  # Test if it works
npm unlink -g sapper  # Clean up
```

### 4. Check Package Contents

See what files will be published:
```bash
npm pack --dry-run
```

### 5. Login to NPM

```bash
npm login
# Enter username, password, email, and 2FA code
```

### 6. Publish

```bash
npm publish
```

If successful, you'll see:
```
+ sapper@1.0.0
```

### 7. Verify Installation

Test global installation:
```bash
npm install -g sapper
sapper --version
```

## Publishing Updates

### For patch updates (1.0.0 → 1.0.1):
```bash
npm version patch
git push --follow-tags
npm publish
```

### For minor updates (1.0.0 → 1.1.0):
```bash
npm version minor  
git push --follow-tags
npm publish
```

### For major updates (1.0.0 → 2.0.0):
```bash
npm version major
git push --follow-tags
npm publish
```

## Troubleshooting

### Package name taken
If "sapper" is taken, try alternatives:
- `sapper-ai`
- `sapper-cli`  
- `ai-sapper`

Update `package.json` name field accordingly.

### Authentication errors
```bash
npm logout
npm login
```

### Permission errors
Check if you have publish rights to the package name.

### Version conflicts
Each publish must have a unique version number. Increment version in `package.json`.

## Post-Publish Steps

1. **Verify on npmjs.com** - Visit `https://npmjs.com/package/sapper`
2. **Test installation** - `npm install -g sapper`
3. **Update README** - Add npm installation instructions
4. **Tag release on GitHub** - Create release tag matching npm version

## NPM Commands Reference

- `npm whoami` - Check logged in user
- `npm view sapper` - View package info
- `npm unpublish sapper@1.0.0` - Remove specific version (within 24hrs)
- `npm deprecate sapper@1.0.0 "reason"` - Mark version as deprecated
- `npm owner ls sapper` - List package owners

## GitHub Integration

After publishing, users can install via:
- `npm install -g sapper` (from npm registry)  
- `npm install -g git+https://github.com/aledanee/sapper.git` (from GitHub)

Keep both npm and GitHub versions synchronized.