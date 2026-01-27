# GitHub Integration Environment Variables

Add the following environment variables to your `.env` file:

```env
# GitHub App Configuration
GITHUB_APP_ID=your_app_id
GITHUB_APP_NAME=your_app_name
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_PRIVATE_KEY=your_private_key_base64_encoded
```

## How to Get These Values

1. **Create a GitHub App:**
   - Go to GitHub Settings → Developer settings → GitHub Apps → New GitHub App
   - Fill in the required information

2. **Configure Permissions:**
   - Repository permissions:
     - Contents: Read-only
     - Metadata: Read-only

3. **Set URLs:**
   - Callback URL: `https://your-domain.com/api/github/callback`
   - User authorization callback URL: `https://your-domain.com/api/github/callback`
   - Webhook URL: `https://your-domain.com/api/webhook/github` (optional)

4. **Get Credentials:**
   - **App ID**: Found on the app settings page
   - **App Name**: The name you gave your GitHub App (used in installation URL)
   - **Client ID**: Found on the app settings page
   - **Client Secret**: Generate a new client secret
   - **Private Key**: Generate and download a private key, then base64 encode it:
     ```bash
     # On Linux/Mac:
     base64 -i your-app.private-key.pem

     # On Windows (PowerShell):
     [Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app.private-key.pem"))
     ```

## Database Migration

After adding the environment variables, run the database migration:

```bash
npx prisma migrate dev --name add_github_integration
npx prisma generate
```

## Install Dependencies

Install the required npm packages:

```bash
npm install
```
