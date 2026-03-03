# Meeting Tasks Bot

## Setup
```bash
npm install
cp .env.example .env.local  # Fill in credentials
```

## Deploy
```bash
git init && git add . && git commit -m "v1.0: Initial scaffold"
gh repo create jeffperoutka/meeting-tasks-bot-v2 --public --source=. --push
# Then import to Vercel from GitHub
```

## Integrations: slack, claude
# Trigger deploy
