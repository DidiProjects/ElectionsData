# ElectionsData

Worker em TypeScript que acompanha a apuração das eleições brasileiras no TSE, município a município, e grava o resultado parcial em arquivos CSV versionados numa pasta do servidor.

Não expõe API nem porta: a entrada é só por variáveis de ambiente e a saída é só a pasta de CSVs.

## Fonte dos dados

O TSE não tem API REST. O site oficial de resultados lê arquivos JSON estáticos servidos por CDN, e o worker consome esses mesmos arquivos:

| Arquivo | URL |
|---|---|
| Eleições e códigos | `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json` |
| Municípios da eleição | `…/{ciclo}/{eleição}/config/mun-e{eleição:6}-cm.json` |
| Acompanhamento por UF | `…/{ciclo}/{eleição}/dados/{uf}/{uf}-e{eleição:6}-ab.json` |
| Resultado por município | `…/{ciclo}/{eleição}/dados/{uf}/{uf}{município}-c{cargo:4}-e{eleição:6}-u.json` |

Exemplo, presidente em São Paulo no 2º turno de 2026:
`https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp71072-c0001-e006258-u.json`

Em 2026 o TSE trocou o formato dos arquivos: o antigo `dados-simplificados/…-r.json`, de 2022 e 2024, agora devolve 404.

### Códigos de 2026

| Eleição | 1º turno | 2º turno |
|---|---|---|
| Federal (presidente) | 6257 | 6258 |
| Estadual (governador, senador, deputados) | 6259 | 6260 |

Cargos: `1` presidente, `3` governador, `5` senador, `6` deputado federal, `7` deputado estadual, `8` deputado distrital.

## Como o worker evita sobrecarregar o TSE

São 5,7 mil municípios por cargo. Consultar todos a cada minuto seria desnecessário, então:

1. **Acompanhamento antes do resultado.** A cada ciclo, o worker baixa um arquivo `-ab.json` por UF (27 no total). Esse arquivo informa, para cada município, o horário da última totalização e quantas seções já foram totalizadas. O worker baixa o resultado só dos municípios em que esses valores mudaram.
2. **Requisição condicional.** Toda requisição envia `If-None-Match` com o ETag da última resposta. Se nada mudou, o CDN responde `304` sem corpo. Fora dos períodos de atualização, um ciclo custa 27 respostas `304` e nenhuma consulta de município.
3. **Compressão.** A resposta vem com gzip: o acompanhamento de SP cai de 480 KB para 45 KB.
4. **Concorrência limitada.** `CONCURRENCY` (padrão 8) é o número máximo de requisições simultâneas.
5. **Retentativas.** Até `MAX_RETRIES` (padrão 3) retentativas para erro de rede, timeout, 408/425/429/5xx e JSON truncado. O intervalo cresce exponencialmente, com *full jitter*, até o máximo de 30 s. 404 e os demais 4xx não são retentados.
6. **Throttling compartilhado.** Um `429` ou `503` respeita o `Retry-After` e pausa **todos** os workers, não só o que recebeu a resposta.
7. **Intervalo mínimo de 30 s.** O CDN guarda os arquivos em cache por cerca de 52 s (`Cache-Control: max-age=52`), então consultar com mais frequência só aumenta a carga.
8. **User-Agent identificado.** As requisições se identificam com o nome do worker e o link do repositório.

O primeiro job baixa todos os municípios, uma vez por cargo, o que leva cerca de 5 minutos para o Brasil inteiro. Depois disso, só o que mudou.

## Regras de atualização

- Um resultado só substitui o anterior quando é **válido**: estrutura completa, eleição, município e cargo iguais aos pedidos, e seções totalizadas ≤ total. Também não pode ser mais antigo que o guardado, comparando o `idg` de geração do TSE.
- Resultado inválido, request que falhou depois das retentativas ou arquivo truncado: o valor anterior é mantido e o município entra de novo no próximo ciclo.
- Um 404 no resultado (por exemplo, governador numa UF sem 2º turno) não é retentado até o acompanhamento daquele município mudar.

## CSV

A cada job completo, a pasta de saída recebe uma pasta nova com o timestamp do job, e os arquivos da raiz são substituídos:

```
OUTPUT_DIR/
├── ele2026_e006258_c0001.csv          ← resultado do job completo mais recente (substituído a cada job)
├── 20261025T200030000Z/               ← uma pasta por job, horário em UTC
│   └── ele2026_e006258_c0001.csv      (um CSV por cargo configurado)
├── 20261025T200130000Z/
│   └── ele2026_e006258_c0001.csv
└── ...
```

- **Quem consome o dado lê o arquivo da raiz.** Ele é sempre um resultado completo: tem todos os municípios, cada um com a contagem mais recente já totalizada pelo TSE.
- Um job só publica quando **todo** município × cargo tem um valor válido ou um 404 confirmado. Enquanto faltar algum (por exemplo, durante a carga inicial ou depois de falhas), não sai pasta e a raiz não muda. O job seguinte busca de novo só o que falta.
- Todo job completo gera a sua pasta, mesmo que o conteúdo seja igual ao do anterior. As pastas se acumulam e nada é apagado: cada pasta de presidente para o Brasil inteiro tem cerca de 6,3 MB. Uma noite de apuração com jobs a cada 60 s soma alguns GB.
- Uma linha por município × candidato, com os totais do município repetidos em cada linha.
- Codificação UTF-8, separador vírgula, decimal com ponto.
- A gravação é atômica: a pasta do job é montada com nome oculto e renomeada só no fim, e os arquivos da raiz são gravados num `.tmp` e depois renomeados. Quem lê nunca encontra um arquivo ou uma pasta pela metade.

Colunas: `election_code, round, office_code, office_name, state, municipality_code, ibge_code, municipality_name, totalization_status, totalization_date, totalization_time, tse_generated_at, sections_total, sections_counted, sections_counted_pct, electorate, turnout, abstention, valid_votes, blank_votes, null_votes, candidate_number, candidate_name, candidate_ballot_name, party, coalition, votes, votes_pct, candidate_status, elected`.

- `totalization_status` vale `not_started`, `in_progress` ou `finished`.
- `elected` só é `true` para os status "Eleito…". O campo bruto do TSE também marca quem foi para o 2º turno, e por isso não é usado.

## Agenda

- `SCHEDULE_START`: antes desse horário, o worker só espera.
- `SCHEDULE_END`: o job em andamento termina, e depois disso o worker para de consultar o TSE.
- Os dois são opcionais e precisam estar em ISO 8601 **com fuso horário**, por exemplo `2026-10-25T17:00:00-03:00`.

Depois que a janela fecha, o processo continua de pé, sem fazer nada. Se ele saísse, o `restart: unless-stopped` o reiniciaria numa janela já fechada, indefinidamente.

Durante a janela, um job roda a cada `POLL_INTERVAL_SECONDS`: ele coleta o que mudou e, se a cobertura estiver completa, exporta. Se um job demora mais que o intervalo, o seguinte começa logo depois, sem acumular jobs.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `ELECTION_CYCLE` | sim | — | Ciclo, ex. `ele2026` |
| `ELECTION_CODE` | sim | — | Código da eleição, ex. `6258` |
| `OFFICE_CODES` | sim | — | Cargos separados por vírgula, ex. `1` ou `3,5` |
| `STATES` | não | todas | UFs separadas por vírgula; `zz` é o exterior |
| `OUTPUT_DIR` | sim | `/data/output` na imagem | Pasta dos CSVs |
| `POLL_INTERVAL_SECONDS` | sim | — | Período do job, coleta + export (≥ 30) |
| `SCHEDULE_START` | não | agora | Início da janela |
| `SCHEDULE_END` | não | nunca | Fim da janela |
| `MAX_RETRIES` | não | `3` | Retentativas por request |
| `RETRY_BASE_DELAY_MS` | não | `1000` | Base do backoff exponencial |
| `REQUEST_TIMEOUT_MS` | não | `15000` | Timeout por tentativa |
| `CONCURRENCY` | não | `8` | Requests simultâneos |
| `TSE_BASE_URL` | não | `https://resultados.tse.jus.br/oficial` | Para testes ou espelho |
| `LOG_LEVEL` | não | `info` | `debug`, `info`, `warn` ou `error` |

Configuração inválida encerra o processo com código 1, listando todos os problemas encontrados.

Atenção ao tamanho: deputado federal em SP tem cerca de 1.000 candidatos por município, o que gera um CSV de centenas de MB.

## Desenvolvimento

```bash
npm install
npm test                # suíte completa
npm run test:coverage   # com cobertura
npm run typecheck
npm run build && node dist/main.js
```

Para rodar localmente com Docker:

```bash
cp .env.example .env    # ajuste eleição, cargos e janela
docker compose up --build
```

Os CSVs aparecem em `OUTPUT_HOST_DIR`, por padrão `./output`.

## Deploy

`.github/workflows/deploy.yml`:

- Em todo push e PR para `main`: roda typecheck e testes.
- Em push para `main`: publica a imagem no GHCR e, via Tailscale + SSH, sobe o container `elections-data-worker` no servidor, montando `OUTPUT_HOST_DIR` em `/data/output`.

Configuração no GitHub:

- **Secrets:** `TAILSCALE_CLIENT_SECRET` e `SSH_PRIVATE_KEY`.
- **Variables:** `TAILSCALE_IP`, `ELECTION_CYCLE`, `ELECTION_CODE` e `OFFICE_CODES`.
- **Variables opcionais:** `STATES`, `SCHEDULE_START`, `SCHEDULE_END`, `OUTPUT_HOST_DIR` (padrão `/srv/elections-data/output`), `POLL_INTERVAL_SECONDS`, `MAX_RETRIES`, `CONCURRENCY` e `LOG_LEVEL`.

## Estrutura

```
src/
  config.ts              env -> AppConfig validado
  app.ts                 composição das dependências
  main.ts                entrypoint, sinais de shutdown
  clock.ts, logger.ts    tempo e log injetáveis (JSON lines)
  domain/types.ts        modelo de domínio
  http/                  cliente HTTP com retry, timeout, ETag e pausa compartilhada
  tse/                   URLs, tipos brutos, validação e mapeamento do TSE
  polling/               ciclo de coleta guiado pelo acompanhamento
  results/               último valor válido por município × cargo
  export/                CSV e snapshot por job
  scheduler/             janela de execução e rotinas periódicas
tests/                   testes unitários (Vitest), espelhando src/
```
