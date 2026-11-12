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
| 5 | Interne provisioning-API `POST /internal/provisioning/workspaces` (S19 ronde A) | dsg.1 |
| 5b | Tokenherstel voor bestaande workspace (Unibox) | dsg.2 |
| 7 | Inkomende berichten (OMNI-T0027) | gepland |

## Forkpatch 5: provisioning-API

Server-naar-server endpoint waarmee Odaveth per kliniek een eigenaar, workspace en
workspace-token aanmaakt.

- Route `apps/builder/src/app/internal/provisioning/workspaces/route.ts` (extern pad
  `/internal/provisioning/workspaces`, alleen `POST`). Auth en body-schema in
  `apps/builder/src/features/provisioning/`. Het eigenlijke werk doet
  `provisioningService.provisionWorkspace` in `packages/business/src/provisioning/service.ts`.
- Auth: `Authorization: Bearer <CHATBOTX_PROVISIONING_SECRET>`; vergelijking constant-time
  op SHA-256-digests. Env ontbreekt, leeg of korter dan 32 tekens: altijd `503
  provisioning_disabled` (fail closed). Verkeerd of ontbrekend geheim: `401`.
- Body `{ownerEmail, ownerName, workspaceName, tokenName, scopes, permission?}`;
  `scopes` is een niet-lege lijst van workspace-tokenscopes of `"all"` (opgeslagen als
  NULL = onbeperkt); `permission` is `full` (standaard) of `read_only`.
- `201 {workspaceId, ownerId, token}`; het token komt één keer terug en wordt nergens
  opgeslagen of gelogd. Bestaat de eigenaar al met een actieve workspace:
  `409 {error, workspaceId}` zonder nieuw token. Twee gelijktijdige aanroepen voor dezelfde
  eigenaar: één krijgt `201`, de andere `409`. Elke respons heeft `Cache-Control: no-store`.
- Geen mail. Het eigenaar-adres ontvangt geen mail, dus de service gaat niet via
  `findOrProvisionRootUser`/`sendAccountCredentials`. De gebruiker krijgt een willekeurig
  wachtwoord van 64 tekens; alleen de hash wordt bewaard, de klaartekst wordt nergens
  teruggegeven of gelogd. `emailVerified` is true, `mustChangePassword` is true (het
  wachtwoord is door niemand gekozen; de vlag raakt alleen sessies, niet het workspace-token).
  SMTP is geen vereiste meer.
- `ownerName` wordt bewaard als naam van de gebruiker. Bestaat de gebruiker al, dan blijft
  zijn naam ongewijzigd.
- Twee commits:
  1. de gebruiker (`userRepository.insertWithCredential`, bestaande functie, eigen transactie);
  2. workspace + eigenaar-lidmaatschap + gebruiksrij + token in één transactie, onder
     dezelfde advisory lock als `workspaceService.ensureFirstForOwner`.

  De gebruiker kan niet in transactie 2: `workspaceService.create` neemt de workspace-seat
  op de globale verbinding (`UserQuota`, foreign key naar de gebruiker), en die ziet een
  nog niet gecommitte gebruiker niet. Eén transactie zou wijzigingen vragen in
  `workspace/service.ts`, `quota-enforcement/service.ts` en `user-quota/service.ts`.
- Bij falen halverwege: na commit 1 blijft een gebruiker zonder workspace achter (geen mail
  verstuurd, wachtwoord onbekend); een nieuwe aanroep vindt hem op e-mail en gaat verder.
  Faalt commit 2, dan is er geen workspace, geen lidmaatschap en geen token, en de seat
  wordt teruggegeven. `500 token_creation_failed` bestaat niet meer.
- Overgenomen van upstreams aanmaakflow: opzoeken in de root-tenant, weigering van
  placeholder-adressen, `userQuotaService.ensureBootstrapPlan`, tenant-resolutie,
  teamleden-quotum, workspace-seat (in community ook de limiet van één workspace),
  één-eigenaar-één-workspace, auditrecord met `SYSTEM_ACTOR` (één record voor workspace en
  token samen, na de commit). Niet overgenomen: de mail met tijdelijk wachtwoord,
  `provisionBootstrapAdmin` en de cloud-job `publishEntitlements` uit de sign-up-hook
  (die laatste twee slaat upstreams admin-flow ook over), en extra leden.
- `/internal` staat in `PUBLIC_ROUTES` (geen sessie-redirect). De route mag nooit via
  Caddy of een ander publiek pad bereikbaar zijn: de reverse proxy weigert `/internal/*`.
  Dat wordt in dsg-eHealth geborgd (Caddy-config en `infra/chatbotx/docker-compose.yml`;
  alleen de Odaveth-API's praten over het interne Docker-netwerk met de builder).
- Vereist op de ChatbotX-VPS: `CHATBOTX_PROVISIONING_SECRET` (≥ 32 tekens) in de env van
  de builder-container. Geen migratie, geen wijziging in de worker.

Geraakte upstream-bestanden (elke regel kan bij een versie-update conflicteren):

| Bestand | Regels |
|---|---|
| `packages/business/src/index.ts` | +1 (export van `./provisioning`) |
| `apps/builder/src/lib/public-routes.ts` | +5 |
| `apps/builder/src/env.ts` | +5 |
| `apps/builder/__tests__/proxy-public-routes.test.ts` | +9 |
| `.env.example` | +7 |

Alleen toevoegingen, geen gewijzigde of verwijderde upstream-regel. `packages/database`
is niet geraakt. De rest van de patch staat in nieuwe bestanden:
`packages/business/src/provisioning/`, `packages/business/__tests__/provisioning-service.test.ts`,
`apps/builder/src/app/internal/`, `apps/builder/src/features/provisioning/` en
`apps/builder/__tests__/internal-provisioning-workspaces-route.test.ts`.

## Forkpatch 5b: tokenherstel voor bestaande workspace

Herstelpad voor Unibox wanneer het eenmalige token uit patch 5 verloren is.

- `POST /internal/provisioning/workspaces/{workspaceId}/tokens`, met dezelfde
  `Authorization: Bearer <CHATBOTX_PROVISIONING_SECRET>` en constant-time auth via
  `provisioning-secret.ts`. Ontbrekend/leeg/geheim korter dan 32 tekens: `503
  {error:"provisioning_disabled"}`; verkeerd of ontbrekend bearer: `401
  {error:"unauthorized"}`.
- Body `{ownerEmail, tokenName, scopes, permission?}` hergebruikt met `.pick()` de
  veldschema's van patch 5: e-mail trim/lowercase, tokennaam 1..100 tekens,
  niet-lege scope-lijst of `"all"` (NULL), `full` (standaard) of `read_only`.
  Workspace-ID is een positief PostgreSQL-bigint in decimale notatie.
- `201 {workspaceId, token}` geeft een nieuw token eenmalig terug; alleen de hash
  wordt opgeslagen. Bestaande tokens blijven geldig. `createToken` bewaakt ook
  hier de bestaande limiet van tien tokens.
- `404 {error:"workspace_not_found"}` voor onbekende, inactieve of verwijderde
  workspace, onbekende root-tenantgebruiker of een gebruiker die geen eigenaar is.
  `workspaceMemberService.findMembership` leest het lidmaatschap en de workspace
  ongecachet; zowel de rol `owner` als `workspace.ownerId` moeten kloppen.
  Alleen lid zijn volstaat niet. Geen kale SQL of nieuwe repository.
- `400` voor ongeldige body/JSON of workspace-ID; overige methoden `405` met
  `Allow: POST`. Elke respons heeft `Cache-Control: no-store`.
- Tokencreatie gebeurt in een transactie; het auditrecord volgt na commit met
  `SYSTEM_ACTOR`. Token, hash en requestbody komen niet in het auditrecord of de
  routelogging. Geen migratie; `packages/database` en worker blijven ongewijzigd.
- Dit endpoint blijft uitsluitend intern, achter dezelfde reverse-proxyblokkade
  als patch 5. Het is uitgezonderd van de publieke workspace-token-API (invariant
  23: API-tokens mogen geen API-tokens uitgeven).

Geraakte upstream-bestanden (uitsluitend toegevoegde regels):

| Bestand | Regels |
|---|---|
| `apps/builder/__tests__/proxy-public-routes.test.ts` | +7 / -0 |

Aanvulling op fork-only patch 5: `packages/business/src/provisioning/service.ts`
(+64 / -0). Nieuwe fork-only bestanden: tokenroute onder
`apps/builder/src/app/internal/provisioning/workspaces/[workspaceId]/tokens/`,
`apps/builder/src/features/provisioning/schema/issue-workspace-token-request.ts`,
`packages/business/__tests__/provisioning-token-service.test.ts` en
`apps/builder/__tests__/internal-provisioning-tokens-route.test.ts`.
Bestaande upstream-regels zijn niet gewijzigd of verwijderd.

## Upstream bijwerken

`git fetch upstream --tags`, nieuwe branch `dsg/v<nieuw>` vanaf de upstream-tag, forkpatches
cherry-picken in volgorde, tag `v<nieuw>-dsg.0`.
