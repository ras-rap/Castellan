import { RANK_NAMES, config, guildDefaults, type GuildPolicy } from '@services/config.ts';
import { shellModeOf } from '@services/workspace/shell.ts';
import { log } from '@utils/logger.ts';

import {
  hardCheck,
  riskAtMost,
  shellRule,
  strictest,
  tierOf,
  type HardDecision,
  type Tier,
  type Verdict,
} from './hard.ts';
import { SAFETY_QUESTIONS, askJev, jevMode, type JevAnswers } from './jev.ts';
import { reviewWithAgent, type ReviewFn } from './review.ts';

import type { Capability, Risk } from '@services/bridge/capabilities.ts';
import type { GuildMember } from 'discord.js';

const logger = log('policy');

export type DecisionLayer =
  'user' | 'tier' | 'matrix' | 'tools' | 'mode' | 'pattern' | 'vibe' | 'jev' | 'jev-degraded' | 'review';

export type Decision = {
  verdict: Verdict;
  layer: DecisionLayer;
  reason: string;
  jev?: JevAnswers;
};

/** What the pipeline hands back after every layer has answered. */
export type DecideDeps = {
  /** Ids that must never be moderated: the server owner and the bot itself. */
  protectedIds?: readonly string[];
  /** Injected in tests; production uses the guild's own agent through {@link reviewWithAgent}. */
  review?: ReviewFn;
};

/**
 * One layer's answer. `verdict` is optional: a layer may also *observe* (`shadow`) and contribute only a note,
 * which lands in the audit reason without changing the outcome.
 */
type Opinion = { verdict?: Verdict; layer: DecisionLayer; reason: string; jev?: JevAnswers };

const withNotes = (reason: string, notes: readonly string[]): string =>
  notes.length === 0 ? reason : `${reason} · ${notes.join(' · ')}`;

/** Extra approval demanded of the classes the code already calls dangerous. */
const DESTRUCTIVE_MARGIN = 0.2;
/** A "this is safe" reading is only worth acting on when Jev is reasonably sure of it. */
const SAFE_CLAIM_CONFIDENCE = 0.5;

/**
 * What vibe mode does with an action a human would otherwise have been asked about. Kept pure so the policy is
 * testable without a Jev call — `decide()` is the only thing that talks to the network.
 *
 * Vibe is "run it unless it looks dangerous", so it vetoes on evidence rather than on the absence of evidence:
 *
 * 1. above `vibe.maxRisk` → a human is asked (the guild said this class is off-limits);
 * 2. a `catastrophic` blast radius → refused, always, whatever the score;
 * 3. a destructive-class action Jev reads as destructive or reversible needs `minApproval + 0.2` — coarse
 *    readings are what let a permission grant look "reversible" at 0.51;
 * 4. a destructive-class action Jev calls `read_only` needs confidence, or a human decides — an unconfident
 *    "it's fine" is not a green light for a delete;
 * 5. otherwise it runs. No other branch asks, because then vibe would just be `ask` with more steps.
 */
export function vibeVerdict(input: { risk: Risk; vibe: GuildPolicy['vibe']; jev?: JevAnswers }): {
  verdict: Verdict;
  reason: string;
} {
  if (!riskAtMost(input.risk, input.vibe.maxRisk))
    return { 'verdict': 'ask', 'reason': `${input.risk} is above vibe.maxRisk=${input.vibe.maxRisk}` };
  if (input.vibe.screen === 'off') return { 'verdict': 'allow', 'reason': 'vibe: screening off' };

  const answers = input.jev;
  if (!answers)
    return input.vibe.askOnUncertain
      ? { 'verdict': 'ask', 'reason': 'vibe: jev unavailable and askOnUncertain is set' }
      : { 'verdict': 'allow', 'reason': 'vibe: jev unavailable, running it' };

  const blast = answers.blast_radius?.choice ?? 'unknown';
  const confidence = answers.blast_radius?.confidence ?? 0;
  const approval = answers.admin_would_approve?.noul ?? 0;
  const detailed = `vibe: jev ${blast}, approval ${approval.toFixed(2)}, confidence ${confidence.toFixed(2)}`;
  const dangerous = input.risk === 'destructive' || input.risk === 'admin';

  if (blast === 'catastrophic') return { 'verdict': 'deny', 'reason': detailed };
  // Jev calling something destructive is a veto on its own, whatever class the code assigned: the sandbox does
  // not make `rm -rf /var` safe just because the call is reversible by design.
  if (blast === 'destructive' && approval < input.vibe.minApproval) return { 'verdict': 'deny', 'reason': detailed };
  if (dangerous && (blast === 'destructive' || blast === 'reversible')) {
    const floor = Math.min(1, input.vibe.minApproval + DESTRUCTIVE_MARGIN);
    return approval < floor ? { 'verdict': 'deny', 'reason': detailed } : { 'verdict': 'allow', 'reason': detailed };
  }
  if (dangerous && blast === 'read_only' && confidence < SAFE_CLAIM_CONFIDENCE)
    return { 'verdict': 'ask', 'reason': `${detailed} — an unconfident "safe" reading` };
  return { 'verdict': 'allow', 'reason': detailed };
}

const jevState = (guildId: string, tier: Tier, capability: Capability, args: Record<string, unknown>) =>
  [
    `Guild: ${guildId}`,
    `Requester rank: ${RANK_NAMES[tier]}`,
    `Tool: ${capability.name} (${capability.risk})`,
    `Tool purpose: ${capability.description}`,
    `Arguments: ${JSON.stringify(args).slice(0, 1500)}`,
  ].join('\n');

const sandboxNote = (guild: { shell: { mode: string } }): string =>
  guild.shell.mode === 'docker'
    ? 'shell commands run inside a per-guild docker container'
    : 'shell commands run directly on the bot host, as the bot user';

/**
 * Layer 2 (Jev) for one `decide()` call: the independent classifier. `ask` mode consults it for anything the
 * ceiling did not refuse, `vibe` mode is what it is named for. Shadow mode contributes a note, never a verdict.
 */
async function jevOpinion(
  guildId: string,
  tier: Tier,
  capability: Capability,
  args: Record<string, unknown>,
  policy: GuildPolicy,
): Promise<Opinion | undefined> {
  if (policy.mode === 'vibe') {
    // `off` anywhere means the operator does not want Jev consulted at all; `shadow` observes without acting.
    const screen = jevMode === 'off' ? 'off' : policy.vibe.screen;
    const answers =
      screen === 'off' ? undefined : await askJev(jevState(guildId, tier, capability, args), SAFETY_QUESTIONS);
    const verdict = vibeVerdict({ 'risk': capability.risk, 'vibe': { ...policy.vibe, screen }, 'jev': answers });
    logger.info('vibe verdict', {
      'tool': capability.name,
      'risk': capability.risk,
      'verdict': verdict.verdict,
      'reason': verdict.reason,
    });
    if (screen === 'shadow' && answers)
      return { 'layer': 'vibe', 'reason': `shadow: ${verdict.reason}`, 'jev': answers };
    return { 'verdict': verdict.verdict, 'layer': 'vibe', 'reason': verdict.reason, 'jev': answers };
  }

  if (jevMode === 'off') return undefined;

  const answers = await askJev(jevState(guildId, tier, capability, args), SAFETY_QUESTIONS);
  if (!answers)
    return jevMode === 'enforce'
      ? { 'verdict': 'ask', 'layer': 'jev-degraded', 'reason': 'jev unavailable; a human decides' }
      : { 'layer': 'jev-degraded', 'reason': 'jev unavailable; shadow only' };

  const blast = answers.blast_radius?.choice ?? 'unknown';
  const confidence = answers.blast_radius?.confidence ?? 0;
  const approval = answers.admin_would_approve?.noul ?? 0;
  logger.info('jev verdict', { 'tool': capability.name, blast, confidence, approval, 'mode': jevMode });

  if (jevMode === 'shadow') return { 'layer': 'jev', 'reason': `shadow: jev would judge ${blast}`, 'jev': answers };
  if (blast === 'catastrophic' || approval < 0.5)
    return {
      'verdict': 'deny',
      'layer': 'jev',
      'reason': `jev: ${blast}, approval ${approval.toFixed(2)}`,
      'jev': answers,
    };
  if ((blast === 'read_only' || blast === 'reversible') && approval >= 0.9 && confidence >= 0.85)
    return {
      'verdict': 'allow',
      'layer': 'jev',
      'reason': `jev: ${blast} with ${confidence.toFixed(2)} confidence`,
      'jev': answers,
    };
  return {
    'verdict': 'ask',
    'layer': 'jev',
    'reason': `jev: ${blast}, approval ${approval.toFixed(2)} needs a human`,
    'jev': answers,
  };
}

/**
 * Layer 3 (agent review): the guild's own primary agent judges the call it is about to make. `off` skips it,
 * `shadow` records what it would have said, `enforce` lets it tighten the verdict. A reviewer that cannot
 * answer under `enforce` produces `ask`, never `allow` — the layer is only ever additive.
 */
async function agentOpinion(input: {
  guildId: string;
  tier: Tier;
  name: string;
  risk: Risk;
  args: Record<string, unknown>;
  sandbox: string;
  policy: GuildPolicy;
  review?: ReviewFn;
}): Promise<Opinion | undefined> {
  const mode = input.policy.review.mode;
  // Deployment kill switch: `REVIEW_MODE=off` beats the guild key, so an operator can stop the model spend.
  if (mode === 'off' || (Bun.env.REVIEW_MODE ?? 'on').toLowerCase() === 'off') return undefined;

  const ask = (input.review ?? reviewWithAgent)({
    'guildId': input.guildId,
    'rank': RANK_NAMES[input.tier],
    'tool': input.name,
    'risk': input.risk,
    'args': input.args,
    'sandbox': input.sandbox,
    'model': input.policy.review.model,
  });

  // Shadow observes without holding anything up: one model turn per unattended call is real latency, and a
  // guild turning this on to look at the readings must not pay it before it decides to enforce.
  if (mode === 'shadow') {
    void ask.then(
      review =>
        logger.info('agent review (shadow)', {
          'guildId': input.guildId,
          'tool': input.name,
          'wouldBe': review?.verdict ?? 'unavailable',
          'confidence': review?.confidence ?? 0,
          'reason': review?.reason?.slice(0, 120) ?? '',
        }),
      error =>
        logger.warn('agent review (shadow) failed', { 'guildId': input.guildId, 'error': String(error).slice(0, 120) }),
    );
    return undefined;
  }

  const review = await ask;
  if (!review) return { 'verdict': 'ask', 'layer': 'review', 'reason': 'agent review unavailable; a human decides' };

  const reason = `agent review: ${review.reason} (${review.confidence.toFixed(2)})`;
  // A confident "allow" is the only thing the reviewer may hand back without a human; low confidence means ask.
  const verdict: Verdict =
    review.verdict === 'allow' && review.confidence < input.policy.review.minConfidence ? 'ask' : review.verdict;
  return { 'verdict': verdict, 'layer': 'review', 'reason': reason };
}

const asDecision = (hard: HardDecision): Decision => ({
  'verdict': hard.verdict,
  'layer': hard.layer,
  'reason': hard.reason,
});

/**
 * The three layers, in order, strictest wins:
 *
 * 1. **hard** (`hardCheck`) — switches, deny/allow lists, fixed argument rules, rank ceiling. No model, no
 *    network, so the same call always gets the same answer.
 * 2. **jev** — the independent classifier; a veto on evidence (catastrophic, unlikely to be approved).
 * 3. **agent review** — the guild's own primary model judging the call it is about to make; a self-check, so it
 *    catches wrong targets and unrequested actions rather than adversarial reasoning.
 *
 * No layer can loosen another: the final verdict is the strictest one returned, and a layer that cannot answer
 * fails to `ask`. `allow`-listed tools and read-only calls are the two documented shortcuts — the owner's allow
 * list is the escape hatch, and reads have nothing to approve.
 */
export async function decide(
  guildId: string,
  member: GuildMember | null,
  capability: Capability,
  args: Record<string, unknown>,
  deps: DecideDeps = {},
): Promise<Decision> {
  const tier = tierOf(guildId, member);
  const guild = config.guild(guildId) ?? guildDefaults();
  const { policy, features } = guild;
  const account = {
    'blocked': member !== null && guild.access.blocked.includes(member.id),
    'profile': member === null ? undefined : guild.access.users[member.id],
  };

  const hard = hardCheck({
    tier,
    capability,
    args,
    policy,
    features,
    account,
    'protectedIds': deps.protectedIds,
    'pterodactyl': guild.pterodactyl,
  });
  if (hard.verdict === 'deny') return asDecision(hard);
  if (capability.risk === 'read') return asDecision(hard);
  // The owner's allow list means "no cards for this tool, ever": it short-circuits the model layers too.
  if (hard.layer === 'tools' && hard.verdict === 'allow') return asDecision(hard);

  // The two model layers run together: Jev is a remote call and the reviewer is a turn on the guild's server.
  // The reviewer is only consulted for a call that would otherwise run *unattended*: when the hard layer already
  // says `ask`, a human is about to look at it, and one model turn of latency buys nothing.
  const opinions = (
    await Promise.all([
      jevOpinion(guildId, tier, capability, args, policy),
      hard.verdict === 'allow'
        ? agentOpinion({
            guildId,
            tier,
            'name': capability.name,
            'risk': capability.risk,
            args,
            'sandbox': sandboxNote(guild),
            policy,
            'review': deps.review,
          })
        : undefined,
    ])
  ).filter((opinion): opinion is Opinion => opinion !== undefined);

  const base = asDecision(hard);
  // The hard verdict is a candidate too: a model layer that is *laxer* than the ceiling changes nothing.
  const decided =
    strictest([
      base,
      ...opinions.filter((opinion): opinion is Opinion & { verdict: Verdict } => opinion.verdict !== undefined),
    ]) ?? base;
  const notes = opinions.filter(opinion => opinion.verdict === undefined).map(opinion => opinion.reason);
  const jev = opinions.find(opinion => opinion.jev !== undefined)?.jev;

  return { ...decided, 'reason': withNotes(decided.reason, notes), ...(jev ? { jev } : {}) };
}

/**
 * The opencode server asks permission for its own tools (`edit` outside `repo/`, `bash`, `webfetch`). Those asks
 * go through the same three layers: the fixed command rules refuse the shapes no card should ever offer, the
 * agent review may veto, and vibe mode consults Jev. In `ask` mode the human card stays the design — the review
 * can only tighten it.
 */
/**
 * What an opencode permission ask is worth. The same `rm` is reversible inside a throwaway container and
 * destructive on the host, so this reads the guild's own shell mode — the one place that decision is made.
 */
export function permissionRisk(guildId: string, permission: string): Risk {
  if (permission === 'webfetch') return 'reversible';
  if (permission !== 'bash') return 'destructive';
  return shellModeOf(guildId) === 'docker' ? 'reversible' : 'destructive';
}

export async function screenPermission(input: {
  guildId: string;
  tier: Tier;
  permission: string;
  patterns: string[];
  review?: ReviewFn;
}): Promise<{ verdict: Verdict; reason: string }> {
  // A fixed command rule refuses the shape outright: no card should ever offer `rm -rf /` for approval.
  const pattern = input.permission === 'bash' ? shellRule(input.patterns.join('\n')) : undefined;
  if (pattern?.verdict === 'deny') return { 'verdict': 'deny', 'reason': pattern.reason };

  const guild = config.guild(input.guildId) ?? guildDefaults();
  const policy = guild.policy;
  // In ask mode the human card is the design, and a model turn before it only delays the card. Vibe mode is the
  // one that runs unattended, so that is where the reviewer earns its latency.
  if (policy.mode !== 'vibe') return { 'verdict': 'ask', 'reason': 'policy mode is not vibe' };

  const risk = permissionRisk(input.guildId, input.permission);

  const screen = jevMode === 'off' ? 'off' : policy.vibe.screen;
  const [opinion, answers] = await Promise.all([
    agentOpinion({
      'guildId': input.guildId,
      'tier': input.tier,
      'name': `permission:${input.permission}`,
      risk,
      'args': { 'patterns': input.patterns },
      'sandbox': sandboxNote(guild),
      policy,
      'review': input.review,
    }),
    screen === 'off'
      ? Promise.resolve(undefined)
      : askJev(
          [
            `Guild: ${input.guildId}`,
            `Requester rank: ${RANK_NAMES[input.tier]}`,
            `Action: opencode permission "${input.permission}"`,
            `Targets: ${input.patterns.join(', ').slice(0, 800)}`,
            `Sandbox: ${sandboxNote(guild)}`,
          ].join('\n'),
          SAFETY_QUESTIONS,
        ),
  ]);

  if (opinion?.verdict === 'deny') return { 'verdict': 'deny', 'reason': opinion.reason };
  const verdict = vibeVerdict({ risk, 'vibe': { ...policy.vibe, screen }, 'jev': answers });
  // Shadow keeps observing: the human card stays, the note explains what Jev would have said.
  if (screen === 'shadow' && answers) return { 'verdict': 'ask', 'reason': `shadow: ${verdict.reason}` };
  // Strictest of Jev and the reviewer: a review that asked still means a card, never a silent run.
  const worst = strictest([
    { 'verdict': verdict.verdict, 'reason': verdict.reason },
    ...(opinion?.verdict ? [{ 'verdict': opinion.verdict, 'reason': opinion.reason }] : []),
  ] as Array<{ verdict: Verdict; reason: string }>);
  return { 'verdict': worst?.verdict ?? 'ask', 'reason': worst?.reason ?? 'no opinion: asking' };
}
