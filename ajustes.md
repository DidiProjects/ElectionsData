Hoje estimamos os votos por município, e gostaria que fosse por sessão eleitoral:

Endereços que o coletor usaria no domingo

O quê	Endereço
Lista de seções da UF, com horário de cada uma	resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/config/{uf}/{uf}-p003221-cs.json
Arquivo auxiliar da seção (status e hash do boletim)	…/arquivo-urna/3221/dados/{uf}/{município}/{zona}/{seção}/p003221-{uf}-m{município}-z{zona}-s{seção}-aux.json
Boletim de urna da seção (votos, binário)	…/{seção}/{hash}/o03221{uf}{município}{zona}{seção}-bu.dat


Dá uma analisada na rede tambéem, tome essas informações como referência mas me diga se temos um caminho claro e estruturado para obtermos os dados nesse formato amanhã na contagem de votos.

eu gostaria de uma estrutura nesse formato:
data_geracao	SG_UF	CD_MUNICIPIO	NR_ZONA	NR_SECAO	dt_totalizacao	votos_13	votos_22	brancos	nulos	comparecimento
2026-10-25 17:15:00	AL	28711	18	123	2026-10-25 17:00:00	89	86	1	11	187
2026-10-25 17:15:00	BA	38490	10	910	2026-10-25 17:00:00	235	70	11	11	327
2026-10-25 17:15:00	AL	27855	3	103	2026-10-25 17:00:00	96	134	4	11	245
2026-10-25 17:15:00	MG	43877	97	129	2026-10-25 17:00:00	75	121	4	8	208
2026-10-25 17:15:00	MG	41769	131	308	2026-10-25 17:00:00	58	82	4	4	148

é claro trazendo todos os dados que temso disponíveis.

Quero também mudar a abordagem de versionamento, vamos gerar arquivos versionados e incrementais, gerando um arquivo por job como fazemos hoje porém acrescentando um contador no final: secoes_2t2026_0, secoes_2t2026_1 e assim sussessivamente. Quero voltar a ter controle sobre a quantidade, vamos armazenar no máximo 1000 arquivos, de forma que quando chegar o 1000, apagamos o primeiro "_0"