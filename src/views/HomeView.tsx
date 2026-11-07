import { useStore, toolById } from "../lib/store";
import { ToolRow } from "../components/ToolRow";
import { themeIcon } from "../lib/icons";
import { listedTools } from "../lib/partof";
import type { Tool } from "../lib/types";

function Section({ title, empty, tools, showTheme = true }: { title: string; empty: string; tools: Tool[]; showTheme?: boolean }) {
  return (
    <section className="mb-9">
      <h2 className="text-[13px] text-faint mb-2 px-1">{title}</h2>
      {tools.length ? (
        <div className="rounded-xl border border-line bg-panel/50">
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} showTheme={showTheme} />
          ))}
        </div>
      ) : (
        <p className="text-[13.5px] text-dim px-1">{empty}</p>
      )}
    </section>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Late one";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView() {
  const s = useStore();
  const { registry, status, pinned, recent, go } = s;
  if (!registry) return null;
  const listed = listedTools(registry.tools);
  const running = registry.tools.filter((t) => status[t.id]?.running);
  const pins = pinned.map((id) => toolById(s, id)).filter(Boolean) as Tool[];
  const recents = recent
    .filter((id) => !pinned.includes(id))
    .map((id) => toolById(s, id))
    .filter(Boolean)
    .slice(0, 6) as Tool[];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-10 pt-10 pb-16">
        <header className="mb-9">
          <h1 className="text-[40px] leading-none font-semibold tracking-[-0.025em]" style={{ fontVariationSettings: '"wdth" 88' }}>
            {greeting()}
          </h1>
          <p className="text-dim mt-3 num">
            {running.length} of {registry.tools.length} tools running across {registry.themes.length} themes.
          </p>
        </header>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 mb-10">
          {registry.themes.map((th) => {
            const Icon = themeIcon(th.icon || th.id);
            const mine = listed.filter((t) => t.theme === th.id || !!t.also_themes?.includes(th.id));
            const live = mine.filter((t) => status[t.id]?.running).length;
            return (
              <button
                key={th.id}
                onClick={() => go({ type: "theme", id: th.id })}
                className="flex items-center gap-2.5 h-11 px-3 rounded-xl border border-line hover:border-transparent text-left transition-colors"
                style={{ background: `color-mix(in srgb, ${th.color} ${live ? 11 : 5}%, transparent)` }}
              >
                <Icon size={17} style={{ color: th.color }} className="shrink-0" />
                <span className="flex-1 truncate text-[13.5px]">{th.name}</span>
                <span className="text-[12px] text-faint num">{mine.length}</span>
              </button>
            );
          })}
        </div>

        <Section title="Running now" empty="Nothing from the tool list is running." tools={running} />
        <Section title="Pinned" empty="Pin tools with the star on any row to keep them here." tools={pins} />
        {recents.length > 0 && <Section title="Recently opened" empty="" tools={recents} />}
      </div>
    </div>
  );
}
