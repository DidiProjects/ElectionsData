# ElectionsData

Worker em TypeScript que coleta, seção eleitoral por seção eleitoral, os boletins de urna (BU) publicados pelo TSE e grava os votos em arquivos CSV versionados numa pasta do servidor.

Não expõe API nem porta: a entrada é só por variáveis de ambiente e a saída é só a pasta de CSVs.

## Fonte dos dados

O TSE não tem API REST. Os boletins de urna ficam em arquivos estáticos servidos por CDN, no mesmo servidor do site oficial de resultados:

| Arquivo | URL |
|---|---|
| Eleições e pleitos | `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json` |
| Seções da UF, com horário de publicação de cada BU | `…/{ciclo}/arquivo-urna/{pleito}/config/{uf}/{uf}-p{pleito:6}-cs.json` |
| Arquivo auxiliar da seção (status e hash do BU) | `…/arquivo-urna/{pleito}/dados/{uf}/{município}/{zona}/{seção}/p{pleito:6}-{uf}-m{município}-z{zona}-s{seção}-aux.json` |
| Boletim de urna (binário ASN.1/DER) | `…/{seção}/{hash}/o{pleito:5}{uf}{município}{zona}{seção}-bu.dat` |
| Nomes dos candidatos por UF | `…/{ciclo}/{eleição}/dados/{uf}/{uf}-c{cargo:4}-e{eleição:6}-u.json` |

O **pleito** agrupa todas as eleições do mesmo dia: `3220` é o 1º turno de 2026 e `3221` é o 2º turno, que também inclui eleições suplementares e consultas populares. Cada BU traz o resultado de todas as eleições votadas naquela urna, e `OFFICE_CODES` escolhe os cargos exportados: `1` presidente, `3` governador, `5` senador, `6` deputado federal, `7` deputado estadual, `8` deputado distrital, `11` prefeito.

### Quando os BUs ficam disponíveis

No 1º turno de 2026, os BUs **não** foram publicados durante a apuração. Saíram em lote por UF, por volta do fim da totalização daquela UF:

| UF | Municípios terminaram de totalizar | BUs publicados |
|---|---|---|
| AC | 16:17 → 18:54 | 21h |
| SP | 17:20 → 22:47 | 22h–23h |
| BA | 18:36 → 00:39 | 0h do dia seguinte |

Por isso, durante a contagem o CSV fica vazio, e as seções aparecem por UF à medida que os lotes saem.

### Validação

O decodificador de BU foi conferido contra o resultado oficial do 1º turno. A soma dos 34 BUs de Porto Walter/AC bate exatamente com o resultado do município em presidente, governador, senador, deputado federal e deputado estadual: cada candidato, brancos, nulos, legenda, comparecimento e aptos.

## Como o worker evita sobrecarregar o TSE

1. **Lista de seções antes do BU.** A cada job, o worker baixa a lista de seções de cada UF (28 com o exterior) e busca aux e BU só das seções que ganharam horário de publicação novo. Um BU é definitivo, então cada seção é baixada **uma única vez**, ou de novo só se o TSE republicar.
2. **Requisição condicional.** As listas de seções são pedidas com `If-None-Match`. Se nada mudou, o CDN responde `304` sem corpo.
3. **Concorrência limitada.** `CONCURRENCY` (padrão 64) é o número máximo de requisições simultâneas.
4. **Retentativas.** Até `MAX_RETRIES` (padrão 3) retentativas para erro de rede, timeout, 408/425/429/5xx e corpo truncado. O intervalo cresce exponencialmente, com *full jitter*, até o máximo de 30 s. 404 e os demais 4xx não são retentados.
5. **Throttling compartilhado.** Um `429` ou `503` respeita o `Retry-After` e pausa **todos** os workers.
6. **Intervalo mínimo de 30 s** entre jobs. O CDN guarda as listas em cache por 60 s.
7. **User-Agent identificado.** As requisições se identificam com o nome do worker e o link do repositório.

**Vazão:** a primeira requisição de cada BU é um cache miss no CDN e leva cerca de 0,5 s, contra cerca de 50 ms nas seguintes. Isso dá, na prática, cerca de `CONCURRENCY` seções por segundo:

| `CONCURRENCY` | Medido no 1º turno | Brasil inteiro (cerca de 470 mil seções) |
|---|---|---|
| 8 | 500 a 860 seções por minuto (AC) | cerca de 9 a 15 h |
| 64 | cerca de 4.000 seções por minuto (PB, 10.712 seções em 3 min 23 s), 0 retentativas e 0 throttling | cerca de 2 h |

**Persistência:** os BUs decodificados ficam no Postgres (ver [Banco de dados](#banco-de-dados)). O primeiro job depois de um start ou redeploy restaura tudo do banco e só baixa o que falta. Ao fim de cada job, as seções novas são gravadas em lotes de 500, cada lote numa transação. Num `docker stop`, o job em andamento grava o que já baixou antes de sair. Se o banco estiver fora do ar, o worker continua coletando e tenta gravar e restaurar de novo no job seguinte.

**Orçamento por job:** um job para de iniciar novas seções quando seu período (`POLL_INTERVAL_SECONDS`) se esgota, exporta e deixa o resto para o próximo. Um lote grande, como o de SP, não segura o export por uma hora.

## CSV

```
OUTPUT_DIR/
├── secoes_2t2026_current.csv     ← sempre o mais recente; não entra na contagem
├── secoes_2t2026_0.csv
├── secoes_2t2026_1.csv
└── ...                           (no máximo MAX_CSV_VERSIONS; ao chegar no limite, o mais antigo é apagado)
```

- **Quem consome o dado lê o `_current`.**
- Cada job gera um arquivo novo, com tudo o que foi coletado até ali, mesmo que nada tenha mudado. A exceção é antes do primeiro BU: aí nada é gravado, para não gastar o limite de versões com arquivos vazios.
- A numeração vem dos arquivos que já estão na pasta (o maior número + 1), então continua depois de um restart ou de uma limpeza manual.
- A gravação é atômica (`.tmp` e depois `rename`), e o conteúdo é gravado em streaming.
- Volume: cada versão com o Brasil inteiro tem centenas de MB, e 1000 versões podem somar centenas de GB.

Formato longo, com **uma linha por seção × cargo × votável**:

```
data_geracao,SG_UF,CD_MUNICIPIO,NM_MUNICIPIO,NR_ZONA,NR_SECAO,SECOES_AGREGADAS,CD_ELEICAO,CD_CARGO,DS_CARGO,TP_VOTO,NR_VOTAVEL,NM_VOTAVEL,QT_VOTOS,QT_APTOS,QT_COMPARECIMENTO,dt_totalizacao,dt_abertura,dt_encerramento,dt_emissao_bu
2026-10-25 21:15:00,AC,01040,MARECHAL THAUMATURGO,4,73,,6258,1,Presidente,nominal,13,LULA,70,279,214,2026-10-25 21:08:15,2026-10-25 06:10:06,2026-10-25 15:00:54,2026-10-25 15:02:37
```

| Coluna | Origem |
|---|---|
| `data_geracao` | horário do job, em Brasília |
| `SECOES_AGREGADAS` | seções agregadas a esta, separadas por `;`. Elas não têm BU próprio e seus votos estão neste |
| `TP_VOTO` | `nominal`, `branco`, `nulo` ou `legenda`; outros tipos aparecem como `tipo_N` |
| `NR_VOTAVEL` / `NM_VOTAVEL` | número e nome na urna; vazios para branco e nulo |
| `QT_APTOS`, `QT_COMPARECIMENTO` | da seção, para aquela eleição |
| `dt_totalizacao` | horário de publicação do BU na lista de seções do TSE |
| `dt_abertura`, `dt_encerramento`, `dt_emissao_bu` | gravados pela urna, **no fuso local da urna** |

Particularidades:

- **Votável sem voto não tem linha.** O próprio BU omite quem não recebeu voto, então linha ausente significa 0.
- **Candidatura anulada.** Um voto nominal num número que não está na lista oficial (por exemplo, candidatura anulada) sai com `NM_VOTAVEL` vazio. O BU registra o voto como nominal, e o resultado oficial o conta como nulo técnico.

## Banco de dados

Postgres 16, com o schema em `migrations/`. As migrations são aplicadas pelo próprio worker no start, com advisory lock, e uma falha encerra o processo com código 1.

| Tabela | Conteúdo |
|---|---|
| `secao` | uma linha por seção com BU: UF, município, zona, seção, seções agregadas, horário de publicação, hash e horários da urna |
| `resultado_cargo` | aptos e comparecimento por seção × eleição × cargo |
| `voto` | tipo, número e quantidade, na ordem do BU |
| `candidato` | nome na urna por eleição × cargo × UF |

O banco guarda **todos** os cargos de cada BU. O `OFFICE_CODES` filtra só o CSV. A view `votos_secao` entrega o mesmo formato longo do CSV:

```sql
-- Presidente por UF
SELECT sg_uf, nm_votavel, sum(qt_votos)
FROM votos_secao WHERE cd_cargo = 1 AND tp_voto = 'nominal'
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

Para consultar, rode `docker exec -it elections-postgres psql -U elections -d elections`. No compose local, a porta também fica em `127.0.0.1:${POSTGRES_HOST_PORT}`.

Validação: depois de um backfill do 1º turno do AC (2.270 seções), as somas da view batem exatamente com o resultado oficial da UF para presidente e governador, em cada candidato, brancos e nulos. No caso dos nulos, eles fecham contando os votos em candidatura anulada.

## Carga avulsa (`MODE=backfill`)

Mesma imagem e mesma configuração. Com `MODE=backfill`, o worker ignora a janela, roda jobs um atrás do outro até não restar nenhuma seção publicada por baixar, grava tudo no banco, gera um CSV e **sai**. Depois, o worker normal (`MODE=job`) começa já com esses dados.

```bash
# local, com o compose
docker compose up -d postgres
docker compose run --rm -e MODE=backfill -e PLEITO_CODE=3220 worker

# no servidor, ao lado do deploy (mesma rede e banco)
sudo docker run --rm --network elections-network \
  -e MODE=backfill -e DATABASE_URL="postgresql://elections:<senha>@elections-postgres:5432/elections" \
  -e ELECTION_CYCLE=ele2026 -e PLEITO_CODE=3220 -e OFFICE_CODES=1,3 -e POLL_INTERVAL_SECONDS=60 \
  -v /srv/elections-data/output:/data/output ghcr.io/didiprojects/electionsdata:latest
```

Serve para carregar um pleito já publicado (o 1º turno), alcançar um lote grande no domingo ou recuperar um início atrasado. **Antes** da apuração do 2º turno não há o que carregar, porque os BUs ainda não existem. Medição: no 1º turno, o AC (2.270 seções) levou 3 min 56 s com `CONCURRENCY=8`, e a PB (10.712 seções) levou 3 min 23 s com `CONCURRENCY=64`. Nos dois casos, a view bateu exatamente com o resultado oficial da UF em presidente, governador e senador.

## Agenda

- `SCHEDULE_START`: antes desse horário, o worker só espera.
- `SCHEDULE_END`: o job em andamento termina, e depois disso o worker para de consultar o TSE.
- Os dois são opcionais e precisam estar em ISO 8601 **com fuso horário**, por exemplo `2026-10-25T17:00:00-03:00`.

Depois que a janela fecha, o processo continua de pé, sem fazer nada. Se ele saísse, o `restart: unless-stopped` o reiniciaria numa janela já fechada, indefinidamente.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `ELECTION_CYCLE` | sim | — | Ciclo, ex. `ele2026` |
| `PLEITO_CODE` | sim | — | Pleito, ex. `3221` (2º turno de 2026) |
| `OFFICE_CODES` | sim | — | Cargos exportados, ex. `1` ou `1,3` |
| `STATES` | não | todas + `zz` | UFs separadas por vírgula |
| `OUTPUT_DIR` | sim | `/data/output` na imagem | Pasta dos CSVs |
| `DATABASE_URL` | sim | — (o compose monta a partir de `POSTGRES_PASSWORD`) | Postgres com os BUs decodificados |
| `MODE` | não | `job` | `job` (janela e jobs periódicos) ou `backfill` (carga avulsa que termina sozinha) |
| `OUTPUT_PREFIX` | não | `secoes` | Prefixo dos arquivos, ex. `secoes_2t2026` |
| `MAX_CSV_VERSIONS` | não | `1000` | Versões numeradas mantidas (o `_current` não conta) |
| `POLL_INTERVAL_SECONDS` | sim | — | Período e orçamento de tempo do job (≥ 30) |
| `SCHEDULE_START` | não | agora | Início da janela |
| `SCHEDULE_END` | não | nunca | Fim da janela |
| `MAX_RETRIES` | não | `3` | Retentativas por request |
| `RETRY_BASE_DELAY_MS` | não | `1000` | Base do backoff exponencial |
| `REQUEST_TIMEOUT_MS` | não | `15000` | Timeout por tentativa |
| `CONCURRENCY` | não | `64` | Requests simultâneos |
| `TSE_BASE_URL` | não | `https://resultados.tse.jus.br/oficial` | Para testes ou espelho |
| `LOG_LEVEL` | não | `info` | `debug`, `info`, `warn` ou `error` |

Configuração inválida encerra o processo com código 1, listando todos os problemas encontrados.

## Desenvolvimento

```bash
npm install
npm test                # suíte sem banco (os testes de Postgres aparecem como pulados)
npm run typecheck
npm run build && node dist/main.js
```

Os testes de migrations, do repositório e o teste de integração com banco só rodam com `TEST_DATABASE_URL`. Cada arquivo de teste cria um schema descartável:

```bash
docker run -d --name ed-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=elections_test -p 54329:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/elections_test npm run test:coverage
```

Para rodar localmente com Docker (worker + Postgres):

```bash
cp .env.example .env    # ajuste pleito, cargos, janela e POSTGRES_PASSWORD
docker compose up --build
```

Os CSVs aparecem em `OUTPUT_HOST_DIR`, por padrão `./output`.

## Deploy

`.github/workflows/deploy.yml`:

- Em todo PR para `main`: roda typecheck e a suíte completa, com um Postgres de serviço e `TEST_DATABASE_URL`.
- **O deploy é manual.** Ele nunca roda num push, só quando você dispara em *Actions → Deploy to Home Server → Run workflow*. Disparado na `main`, roda os testes, publica a imagem no GHCR e, via Tailscale + SSH, prepara o servidor e sobe o worker. Disparado em qualquer outra branch, roda só os testes:
  - cria a rede `elections-network`, se ainda não existir;
  - sobe o `elections-postgres`, com volume `elections_postgres_data`, e espera o `pg_isready`;
  - sobe o container `elections-data-worker`, montando `OUTPUT_HOST_DIR` em `/data/output`.

Configuração no GitHub:

- **Secrets:** `TAILSCALE_CLIENT_SECRET`, `SSH_PRIVATE_KEY` e `POSTGRES_PASSWORD`.
- **Variables:** `TAILSCALE_IP`, `ELECTION_CYCLE`, `PLEITO_CODE` e `OFFICE_CODES`.
- **Variables opcionais:** `STATES`, `SCHEDULE_START`, `SCHEDULE_END`, `OUTPUT_HOST_DIR` (padrão `/srv/elections-data/output`), `OUTPUT_PREFIX`, `MAX_CSV_VERSIONS`, `POLL_INTERVAL_SECONDS`, `MAX_RETRIES`, `CONCURRENCY` e `LOG_LEVEL`.

## Estrutura

```
src/
  config.ts              env -> AppConfig validado
  app.ts                 composição das dependências
  main.ts                entrypoint, sinais de shutdown
  clock.ts, logger.ts    tempo e log injetáveis (JSON lines)
  domain/types.ts        seção e resultado por seção
  http/                  cliente HTTP (JSON e binário) com retry, timeout, ETag e pausa compartilhada
  urna/                  URLs, tipos, validação, leitor BER e decodificador do BU
  polling/               job de coleta guiado pela lista de seções
  db/                    pool do Postgres, transações e migrations
  results/               BUs coletados por seção, em memória e no Postgres
migrations/              schema SQL, aplicado pelo worker no start
  export/                CSV longo, nomes de candidatos e versionamento _N / _current
  scheduler/             janela de execução e rotina periódica
tests/                   testes unitários (Vitest), espelhando src/
```
