import { BerError, isContext, isUniversal, parseBer, readInteger, readString, UNIVERSAL, type BerNode } from './ber.js';

/**
 * Decodes the TSE ballot box report (BU, `-bu.dat`): a DER envelope whose OCTET STRING
 * holds the report itself. Layout checked against 2026 first-round files, whose sums
 * match the official municipality results exactly.
 */

export type VoteType = 'nominal' | 'branco' | 'nulo' | 'legenda' | `tipo_${number}`;

export interface BuVote {
  type: VoteType;
  /** Candidate number (or party number for legend votes); null for blank/null votes. */
  number: number | null;
  votes: number;
}

export interface BuOfficeResult {
  electionId: number;
  officeCode: number;
  eligible: number;
  turnout: number;
  votes: BuVote[];
}

export interface BallotBoxReport {
  municipality: number;
  zone: number;
  section: number;
  /** Times as written by the ballot box, in its local timezone: YYYYMMDDTHHMMSS. */
  emittedAt: string;
  openedAt: string;
  closedAt: string;
  results: BuOfficeResult[];
}

const VOTE_TYPES: Record<number, VoteType> = { 1: 'nominal', 2: 'branco', 3: 'nulo', 4: 'legenda' };
const TIMESTAMP = /^\d{8}T\d{6}$/;

const only = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new BerError(`BU without ${what}`);
  return value;
};

function sectionIdentity(body: BerNode[]): { municipality: number; zone: number; section: number } {
  const node = body.find(
    (n) =>
      isUniversal(n, UNIVERSAL.sequence) &&
      n.children.length === 3 &&
      isUniversal(n.children[0], UNIVERSAL.sequence) &&
      n.children[0].children.length === 2 &&
      n.children[0].children.every((c) => isUniversal(c, UNIVERSAL.integer)) &&
      isUniversal(n.children[2], UNIVERSAL.integer),
  );
  const found = only(node, 'section identification');
  return {
    municipality: readInteger(found.children[0]?.children[0] as BerNode),
    zone: readInteger(found.children[0]?.children[1] as BerNode),
    section: readInteger(found.children[2] as BerNode),
  };
}

function decodeVote(node: BerNode): BuVote {
  const typeNode = only(node.children.find((c) => isContext(c, 1)), 'vote type');
  const code = readInteger(typeNode);
  const qty = node.children.find((c) => isContext(c, 2));
  const ident = node.children.find((c) => isContext(c, 3));
  return {
    type: VOTE_TYPES[code] ?? `tipo_${code}`,
    number: ident ? readInteger(only(ident.children[1], 'candidate number')) : null,
    votes: qty ? readInteger(qty) : 0,
  };
}

function decodeElection(node: BerNode): BuOfficeResult[] {
  const [idNode, eligibleNode] = node.children;
  const electionId = readInteger(only(idNode, 'election id'));
  const eligible = readInteger(only(eligibleNode, 'eligible voters'));
  const results = only(node.children.find((c) => isUniversal(c, UNIVERSAL.sequence)), 'results');

  return results.children.flatMap((resultado) => {
    // ResultadoVotacao: tipoCargo, qtdComparecimento, totaisVotosCargo
    const turnout = readInteger(only(resultado.children[1], 'turnout'));
    const totals = only(resultado.children[2], 'office totals');
    return totals.children.flatMap((cargo) => {
      const officeNode = cargo.children[0];
      // [1] constitutional office; [2] would be a free-form referendum question.
      if (!isContext(officeNode, 1)) return [];
      const votes = only(cargo.children.find((c) => isUniversal(c, UNIVERSAL.sequence)), 'votes');
      return [
        {
          electionId,
          officeCode: readInteger(officeNode),
          eligible,
          turnout,
          votes: votes.children.map(decodeVote),
        },
      ];
    });
  });
}

export function decodeBallotBoxReport(file: Buffer): BallotBoxReport {
  const envelope = only(parseBer(file)[0], 'envelope');
  const content = only(envelope.children.find((c) => isUniversal(c, UNIVERSAL.octetString)), 'envelope content');
  const body = only(parseBer(content.value)[0], 'report').children;

  const emitted = body.find((n) => isUniversal(n, UNIVERSAL.generalString) && TIMESTAMP.test(readString(n)));
  const window = body.find(
    (n) => isContext(n, 0) && n.children.length === 2 && n.children.every((c) => isUniversal(c, UNIVERSAL.generalString)),
  );
  const perElection = body.find(
    (n) =>
      isUniversal(n, UNIVERSAL.sequence) &&
      n.children.length > 0 &&
      n.children.every(
        (e) =>
          isUniversal(e, UNIVERSAL.sequence) &&
          isUniversal(e.children[0], UNIVERSAL.integer) &&
          e.children.some((c) => isUniversal(c, UNIVERSAL.sequence)),
      ),
  );

  return {
    ...sectionIdentity(body),
    emittedAt: readString(only(emitted, 'emission time')),
    openedAt: readString(only(window?.children[0], 'opening time')),
    closedAt: readString(only(window?.children[1], 'closing time')),
    results: only(perElection, 'results per election').children.flatMap(decodeElection),
  };
}
