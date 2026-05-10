# npm Publishing — 2FA / Access Token Setup

## The Error
```
403 Forbidden - PUT https://registry.npmjs.org/claw-clean
Two-factor authentication or granular access token with bypass 2fa enabled is required
```

## Fix Options

### Option A: Granular Access Token (Recommended)
1. Go to https://www.npmjs.com/settings/<username>/tokens
2. Click **"Granular Access Token"**
3. Set:
   - **Token name**: `claw-clean-publish`
   - **Packages**: Only **claw-clean**
   - **Permissions**: Read + Write
   - **Bypass 2FA**: ✅ Enable (this avoids the 2FA prompt)
4. Copy the token
5. Login with it:
   ```bash
   npm login
   # When prompted for password, paste the token
   ```

### Option B: Enable 2FA on Your Account
1. Go to https://www.npmjs.com/settings/<username>/security
2. Enable 2FA
3. When publishing, npm will prompt for OTP code

### Option C: Use `--otp` Flag
If 2FA is already enabled:
```bash
npm publish --otp=123456
```

## Quick Fix (Option A)

```bash
# 1. Create token at npmjs.com (see steps above)

# 2. Login with the token
npm login
# Username: your npm username
# Password: paste the granular token here

# 3. Publish
npm publish
```

## Verify You're Logged In

```bash
npm whoami
# Should show your username
```

## After Publishing

Verify it's live:
```bash
npm view claw-clean
```

Install globally:
```bash
npm install -g claw-clean
```

## Notes

- Granular tokens are scoped to specific packages — safer than full account tokens
- The token bypasses 2FA only for publishing that specific package
- Keep the token in a password manager, not in shell history
