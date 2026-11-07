import { useStore } from "../lib/store";
import { themeIcon } from "../lib/icons";
import { ToolRow } from "../components/ToolRow";
import { listedTools } from "../lib/partof";
import type { Tool, ToolKind } from "../lib/types";

// Desktop apps first: they're usually the hubs the rest hang off.
const KIND_ORDER: ToolKind[] = ["app", "web", "service"];
const KIND_TITLES: Record<ToolKind, string> = {
  app: "Desktop apps",
  web: "Pages that open here",
  service: "Background services",
};

export const inTheme = (t: Tool, theme: string) => t.theme === theme || !!t.also_themes?.includes(theme);

export function ThemeView({ id }: { id: string }) {
  const registry = useStore((s) => s.registry);
  const status = useStore((s) => s.status);
  const theme = registry?.themes.find((t) => t.id === id);
  if (!registry || !theme) return <div className="p-10 text-dim">This theme isn't in the tool list anymore.</div>;

  // Tools merged into a hub (part_of) never get their own row: the hub's row lists them.
  const tools = listedTools(registry.tools);
  const byId = new Map(tools.map((t) => [t.id, t]));
  const partIds = new Set(tools.flatMap((t) => t.parts ?? []));
  const hostShownHere = (t: Tool) => {
    const host = t.hosted_in && byId.get(t.hosted_in.tool);
    return !!host && inTheme(host, id);
  };
  // Top level: tools in this theme that aren't someone's part and aren't nested under a host shown here.
  const top = tools.filter((t) => inTheme(t, id) && !partIds.has(t.id) && !hostShownHere(t));
  const hostedUnder = (host: Tool) => tools.filter((t) => t.hosted_in?.tool === host.id && inTheme(t, id) && !partIds.has(t.id));
  const partsOf = (t: Tool) => (t.parts ?? []).map((p) => byId.get(p)).filter(Boolean) as Tool[];

  const visible = new Set<string>();
  const renderParts = (t: Tool, depth: number) =>
    partsOf(t).map((p) => {
      visible.add(p.id);
      return <ToolRow key={p.id} tool={p} depth={depth} tag="part" />;
    });
  const renderTool = (t: Tool) => {
    visible.add(t.id);
    const hosted = hostedUnder(t);
    const host = t.hosted_in && byId.get(t.hosted_in.tool);
    const tag = host ? `also in ${host.name}, ${t.hosted_in!.tab} tab` : undefined;
    return (
      <ToolRow key={t.id} tool={t} tag={tag}>
        {hosted.map((h) => {
          visible.add(h.id);
          return (
            <ToolRow key={h.id} tool={h} depth={1} tag={`${h.hosted_in!.tab} tab`}>
              {renderParts(h, 2)}
            </ToolRow>
          );
        })}
        {renderParts(t, 1)}
      </ToolRow>
    );
  };

  const sections = KIND_ORDER.map((kind) => ({ kind, tools: top.filter((t) => t.kind === kind) })).filter((s) => s.tools.length);
  const rendered = sections.map((s) => ({ ...s, rows: s.tools.map(renderTool) }));
  const live = [...visible].filter((tid) => status[tid]?.running).length;
  const Icon = themeIcon(theme.icon || theme.id);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-10 pt-10 pb-16">
        <header className="flex items-end gap-5 mb-8">
          <div
            className="w-14 h-14 rounded-2xl grid place-items-center shrink-0"
            style={{ background: `color-mix(in srgb, ${theme.color} 16%, transparent)`, color: theme.color }}
          >
            <Icon size={28} />
          </div>
          <div className="flex-1">
            <h1 className="text-[34px] leading-none font-semibold tracking-[-0.02em]" style={{ fontVariationSettings: '"wdth" 90' }}>
              {theme.name}
            </h1>
            <p className="text-dim mt-2 num">
              {visible.size} {visible.size === 1 ? "tool" : "tools"}, {live} running
            </p>
          </div>
        </header>

        {rendered.length === 0 && (
          <p className="text-dim">No tools here yet. Use “Add a tool” in the sidebar to put one in this theme.</p>
        )}

        {rendered.map((s) => (
          <section key={s.kind} className="mb-8">
            <h2 className="text-[13px] text-faint mb-2 px-1">{KIND_TITLES[s.kind]}</h2>
            <div className="rounded-xl border border-line bg-panel/50">{s.rows}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
