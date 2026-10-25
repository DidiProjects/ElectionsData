-- One row per principal section (aggregated sections have no BU of their own).
CREATE TABLE secao (
    id               bigserial PRIMARY KEY,
    cd_pleito        integer   NOT NULL,
    sg_uf            text      NOT NULL,
    cd_municipio     text      NOT NULL,
    nm_municipio     text      NOT NULL,
    nr_zona          integer   NOT NULL,
    nr_secao         integer   NOT NULL,
    secoes_agregadas integer[] NOT NULL DEFAULT '{}',
    -- Raw TSE stamp ("dd/mm/yyyy hh:mm:ss"): compared verbatim to detect republication.
    publicacao_tse   text      NOT NULL,
    dt_totalizacao   timestamp NOT NULL,
    hash_bu          text      NOT NULL,
    -- Written by the ballot box in its local timezone.
    dt_abertura      timestamp,
    dt_encerramento  timestamp,
    dt_emissao_bu    timestamp,
    atualizado_em    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cd_pleito, sg_uf, cd_municipio, nr_zona, nr_secao)
);

CREATE TABLE resultado_cargo (
    id                bigserial PRIMARY KEY,
    secao_id          bigint  NOT NULL REFERENCES secao (id) ON DELETE CASCADE,
    cd_eleicao        integer NOT NULL,
    cd_cargo          integer NOT NULL,
    qt_aptos          integer NOT NULL,
    qt_comparecimento integer NOT NULL,
    UNIQUE (secao_id, cd_eleicao, cd_cargo)
);

-- Votables without votes are absent from the BU, so a missing row means zero.
CREATE TABLE voto (
    resultado_id bigint  NOT NULL REFERENCES resultado_cargo (id) ON DELETE CASCADE,
    ordem        integer NOT NULL,
    tp_voto      text    NOT NULL,
    nr_votavel   integer,
    qt_votos     integer NOT NULL,
    PRIMARY KEY (resultado_id, ordem)
);

CREATE TABLE candidato (
    cd_eleicao integer NOT NULL,
    cd_cargo   integer NOT NULL,
    sg_uf      text    NOT NULL,
    nr_votavel integer NOT NULL,
    nm_votavel text    NOT NULL,
    PRIMARY KEY (cd_eleicao, cd_cargo, sg_uf, nr_votavel)
);

CREATE INDEX resultado_cargo_eleicao_cargo ON resultado_cargo (cd_eleicao, cd_cargo);
CREATE INDEX voto_votavel ON voto (nr_votavel);

-- Same shape as the CSV export (without data_geracao, which belongs to a file).
CREATE VIEW votos_secao AS
SELECT
    s.cd_pleito,
    upper(s.sg_uf)                         AS sg_uf,
    s.cd_municipio,
    s.nm_municipio,
    s.nr_zona,
    s.nr_secao,
    array_to_string(s.secoes_agregadas, ';') AS secoes_agregadas,
    r.cd_eleicao,
    r.cd_cargo,
    CASE r.cd_cargo
        WHEN 1 THEN 'Presidente'
        WHEN 3 THEN 'Governador'
        WHEN 5 THEN 'Senador'
        WHEN 6 THEN 'Deputado Federal'
        WHEN 7 THEN 'Deputado Estadual'
        WHEN 8 THEN 'Deputado Distrital'
        WHEN 11 THEN 'Prefeito'
        WHEN 13 THEN 'Vereador'
        ELSE 'Cargo ' || r.cd_cargo
    END                                    AS ds_cargo,
    v.tp_voto,
    v.nr_votavel,
    CASE WHEN v.tp_voto = 'nominal' THEN c.nm_votavel END AS nm_votavel,
    v.qt_votos,
    r.qt_aptos,
    r.qt_comparecimento,
    s.dt_totalizacao,
    s.dt_abertura,
    s.dt_encerramento,
    s.dt_emissao_bu,
    v.ordem
FROM secao s
JOIN resultado_cargo r ON r.secao_id = s.id
JOIN voto v ON v.resultado_id = r.id
LEFT JOIN candidato c
       ON c.cd_eleicao = r.cd_eleicao
      AND c.cd_cargo = r.cd_cargo
      AND c.sg_uf = s.sg_uf
      AND c.nr_votavel = v.nr_votavel;
