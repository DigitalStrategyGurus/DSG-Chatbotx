# DSG-Chatbotx: fork van ChatbotXIO/ChatbotX

Fork voor DigitalStrategyGurus (Unibox/Odaveth). Elke wijziging op upstream is één commit
met prefix `forkpatch(<n>):` op een branch `dsg/v<upstream-versie>`.

## Releases

- Branch `dsg/v1.19.0` vanaf upstream-tag `v1.19.0`.
- Tag `v1.19.0-dsg.<n>` start `release.yml`: quality gate (`ci.yml`), daarna images
  `ghcr.io/digitalstrategygurus/chatbotx-{builder,worker,realtime,mcp,javascript-executor}:1.19.0-dsg.<n>`.
- De VPS bouwt niets; `infra/chatbotx/docker-compose.yml` in dsg-eHealth pint de tag.

## Forkpatches

| Nr | Onderwerp | Sinds |
|---|---|---|
| 0 | Publish- en labeler-workflows alleen in upstream (`github.repository`-guard) | dsg.0 |
| 5 | Interne provisioning-API `POST /internal/provisioning/workspaces` (S19 ronde A) | gepland |
| 7 | Inkomende berichten (OMNI-T0027) | gepland |

## Upstream bijwerken

`git fetch upstream --tags`, nieuwe branch `dsg/v<nieuw>` vanaf de upstream-tag, forkpatches
cherry-picken in volgorde, tag `v<nieuw>-dsg.0`.
