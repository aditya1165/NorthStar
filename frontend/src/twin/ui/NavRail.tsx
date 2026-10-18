import { Box, Crosshair, Footprints, Layers, Route, ScanLine, Tag, Waves } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { useTwinStore, type CameraPreset, type LayerKey } from "../state/twinStore";

const LAYERS: { key: LayerKey; label: string; icon: LucideIcon }[] = [
  { key: "agents", label: "Pedestrians", icon: Footprints },
  { key: "density", label: "Current density", icon: Waves },
  { key: "forecast", label: "Forecast volumes", icon: Layers },
  { key: "routes", label: "Routes", icon: Route },
  { key: "labels", label: "Labels", icon: Tag },
];

const CAMERAS: { key: CameraPreset; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview camera", icon: Box },
  { key: "top", label: "Top-down camera", icon: ScanLine },
  { key: "incident", label: "Focus Gate B", icon: Crosshair },
];

function RailButton({ label, icon: Icon, pressed, onClick }: { label: string; icon: LucideIcon; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group relative grid h-9 w-9 place-items-center rounded-md border transition-colors",
        pressed ? "border-ti-edge bg-[#232326] text-warm" : "border-transparent text-ti-dim hover:text-ti-text",
      )}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}

export function NavRail({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const layers = useTwinStore((s) => s.layers);
  const camera = useTwinStore((s) => s.camera.preset);
  const { toggleLayer, setCamera } = useTwinStore.getState();
  const vertical = orientation === "vertical";

  return (
    <nav
      aria-label="View controls"
      className={cn("flex items-center gap-1", vertical ? "flex-col border-r border-ti-line bg-void/60 px-2 py-3" : "flex-row flex-wrap")}
    >
      {vertical && <span className="cg-label mb-1 text-[9px]">View</span>}
      {LAYERS.map((l) => (
        <RailButton key={l.key} label={`${l.label} layer`} icon={l.icon} pressed={layers[l.key]} onClick={() => toggleLayer(l.key)} />
      ))}
      <span aria-hidden className={cn("bg-ti-line", vertical ? "my-2 h-px w-6" : "mx-1 h-6 w-px")} />
      {CAMERAS.map((c) => (
        <RailButton key={c.key} label={c.label} icon={c.icon} pressed={camera === c.key} onClick={() => setCamera(c.key)} />
      ))}
    </nav>
  );
}
