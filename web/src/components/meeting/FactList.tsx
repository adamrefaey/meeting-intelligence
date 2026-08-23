import { Badge } from '../ui/Badge';
import type { ActionItem, Decision } from '../../lib/api';

type FactListProps = {
  decisions: Decision[];
  actionItems: ActionItem[];
};

function DecisionRow({ item }: { item: Decision }) {
  return (
    <li className="rounded-md border border-border border-l-2 border-l-accent bg-surface-raised px-3 py-2 shadow-raised">
      <div className="flex items-start gap-2">
        <Badge variant="accent" className="mt-0.5 shrink-0">
          Decision
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-foreground">{item.text}</p>
          {item.speaker || item.timestamp ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted">
              {item.speaker ? (
                <span className="min-w-0 wrap-break-word">{item.speaker}</span>
              ) : null}
              {item.timestamp ? (
                <span className="font-mono whitespace-nowrap">{item.timestamp}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ActionRow({ item }: { item: ActionItem }) {
  const meta = [item.owner, item.due].filter(Boolean).join(' · ');
  return (
    <li className="rounded-md border border-border border-l-2 border-l-positive bg-surface-raised px-3 py-2 shadow-raised">
      <div className="flex items-start gap-2">
        <Badge variant="positive" className="mt-0.5 shrink-0">
          Action
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-foreground">{item.text}</p>
          {meta || item.timestamp ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted">
              {meta ? <span className="min-w-0 wrap-break-word">{meta}</span> : null}
              {item.timestamp ? (
                <span className="font-mono whitespace-nowrap">{item.timestamp}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function FactList({ decisions, actionItems }: FactListProps) {
  if (decisions.length === 0 && actionItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      {decisions.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] leading-4 font-semibold tracking-[0.14em] text-muted uppercase">
            Decisions
          </h2>
          <ul className="flex flex-col gap-2">
            {decisions.map((item) => (
              <DecisionRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}
      {actionItems.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] leading-4 font-semibold tracking-[0.14em] text-muted uppercase">
            Action items
          </h2>
          <ul className="flex flex-col gap-2">
            {actionItems.map((item) => (
              <ActionRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
