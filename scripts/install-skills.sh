#!/usr/bin/env bash
# Install the agent skills used by this template.
# Source of truth: docs/superpowers/specs/2026-07-02-ai-ready-monorepo-template-design.md (## Skills)
set -euo pipefail

npx skills add https://github.com/ccheney/robust-skills --skill clean-ddd-hexagonal
npx skills add https://github.com/kadajett/agent-nestjs-skills --skill nestjs-best-practices
npx skills add https://github.com/wshobson/agents --skill nodejs-backend-patterns
npx skills add https://github.com/mrgoonie/claudekit-skills --skill backend-development
npx skills add https://github.com/claude-office-skills/skills --skill telegram-bot
npx skills add https://github.com/jeffallan/claude-skills --skill devops-engineer
npx skills add https://github.com/jeffallan/claude-skills --skill architecture-designer
npx skills add https://github.com/zenstackhq/skills --skill zenstack-project-setup
npx skills add https://github.com/zenstackhq/skills --skill zenstack-schema-modeling
npx skills add https://github.com/zenstackhq/skills --skill zenstack-access-control
npx skills add https://github.com/zenstackhq/skills --skill zenstack-querying
npx skills add https://github.com/zenstackhq/skills --skill zenstack-crud-server
npx skills add https://github.com/zenstackhq/skills --skill zenstack-db-migration
npx skills add https://github.com/aj-geddes/useful-ai-prompts --skill ansible-automation
