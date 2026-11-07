import {
  AudioLines, Bot, Brush, Clapperboard, Code2, Coins, Gamepad2, GraduationCap, Image,
  Megaphone, Music, Sparkles, Wrench, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  content: Megaphone,
  music: Music,
  code: Code2,
  image: Image,
  video: Clapperboard,
  voice: AudioLines,
  ai: Bot,
  money: Coins,
  games: Gamepad2,
  utility: Wrench,
  school: GraduationCap,
  art: Brush,
  sparkles: Sparkles,
};

export function themeIcon(name: string): LucideIcon {
  return ICONS[name] ?? Sparkles;
}
