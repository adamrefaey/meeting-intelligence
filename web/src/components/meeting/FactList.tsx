import { Badge } from '../ui/Badge';
import { cn } from '../../lib/cn';
import type { ActionItem, Decision } from '../../lib/api';

const factKind = {
  decision: { badge: 'accent', label: 'Decision', edge: 'border-l-accent' },
  action: { badge: 'positive', label: 'Action', edge: 'border-l-positive' },
} as const;

type FactKind = keyof typeof factKind;

type Fact = { id: number; text: string; detail: string | null; timestamp: string | null };

function FactRow({ kind, fact }: { kind: FactKind; fact: Fact }) {
  const { badge, label, edge } = factKind[kind];
  return (
    <li
      className={cn(
        'rounded-md border border-border border-l-2 bg-surface-raised px-3 py-2 shadow-raised',
        edge,
      )}
    >
      <div className="flex items-start gap-2">
        <Badge variant={badge} className="mt-0.5 shrink-0">
          {label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-foreground">{fact.text}</p>
          {fact.detail || fact.timestamp ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted">
              {fact.detail ? <span className="min-w-0 wrap-break-word">{fact.detail}</span> : null}
              {fact.timestamp ? (
                <span className="font-mono whitespace-nowrap">{fact.timestamp}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function FactSection({ heading, kind, facts }: { heading: string; kind: FactKind; facts: Fact[] }) {
  if (facts.length === 0) {
    return null;
  }
  return (
    <section>
      <h2 className="mb-2 text-[11px] leading-4 font-semibold tracking-[0.14em] text-muted uppercase">
        {heading}
      </h2>
      <ul className="flex flex-col gap-2">
        {facts.map((fact) => (
          <FactRow key={fact.id} kind={kind} fact={fact} />
        ))}
      </ul>
    </section>
  );
}

type FactListProps = { decisions: Decision[]; actionItems: ActionItem[] };

export function FactList({ decisions, actionItems }: FactListProps) {
  if (decisions.length === 0 && actionItems.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 flex flex-col gap-4">
      <FactSection
        heading="Decisions"
        kind="decision"
        facts={decisions.map((item) => ({ ...item, detail: item.speaker }))}
      />
      <FactSection
        heading="Action items"
        kind="action"
        facts={actionItems.map((item) => ({
          ...item,
          detail: [item.owner, item.due].filter(Boolean).join(' · '),
        }))}
      />
    </div>
  );
}
