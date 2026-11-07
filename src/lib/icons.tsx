import {
  ArrowLeftRight, AudioLines, Bot, Brush, Clapperboard, Coins, Disc3, Gamepad2, GraduationCap, Image,
  Megaphone, MonitorPlay, Sparkles, Wrench, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  vj: MonitorPlay,
  dj: Disc3,
  content: Megaphone,
  image: Image,
  video: Clapperboard,
  voice: AudioLines,
  ai: Bot,
  money: Coins,
  games: Gamepad2,
  utility: Wrench,
  school: GraduationCap,
  cross: ArrowLeftRight,
  art: Brush,
  sparkles: Sparkles,
};

export function themeIcon(name: string): LucideIcon {
  return ICONS[name] ?? Sparkles;
}
