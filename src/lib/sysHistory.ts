// Rolling samples behind the System page charts. The title-bar poll feeds the
// machine history all the time, so the charts are full the moment the page
// opens; drive and network samples only arrive while the page is open.
import type { GpuStats, Overview, SysStats } from "./types";

export const WINDOW_MS = 10 * 60 * 1000;

export interface MachineSample {
  t: number;
  cpu: number;
  ram: number;
  gpu: number | null;
  vram: number | null;
}

export interface IoSample {
  t: number;
  rx: number;
  tx: number;
  read: number;
  write: number;
}

export const machine: MachineSample[] = [];
export const io: IoSample[] = [];

function trim<T extends { t: number }>(list: T[], now: number) {
  while (list.length && list[0].t < now - WINDOW_MS) list.shift();
}

export function pushMachine(sys: SysStats, gpu: GpuStats | null) {
  const t = Date.now();
  machine.push({
    t,
    cpu: sys.cpu,
    ram: sys.mem_total ? (sys.mem_used / sys.mem_total) * 100 : 0,
    gpu: gpu ? gpu.util : null,
    vram: gpu && gpu.mem_total ? (gpu.mem_used / gpu.mem_total) * 100 : null,
  });
  trim(machine, t);
}

export function pushIo(o: Overview) {
  const t = Date.now();
  const sum = <K extends string>(rows: Record<K, number>[], k: K) => rows.reduce((n, r) => n + r[k], 0);
  io.push({ t, rx: sum(o.nets, "rx_bps"), tx: sum(o.nets, "tx_bps"), read: sum(o.disks, "read_bps"), write: sum(o.disks, "write_bps") });
  trim(io, t);
}
