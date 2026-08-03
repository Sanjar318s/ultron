"""System report for the sys-report skill (Windows + POSIX). Prints JSON."""

import ctypes
import json
import os
import platform
import shutil
import sys
import time

DISK_DRIVES = ["C:", "D:", "E:", "F:"] if sys.platform == "win32" else ["/"]


def uptime_hours():
    if sys.platform == "win32":
        try:
            ctypes.windll.kernel32.GetTickCount64.restype = ctypes.c_ulonglong
            return round(ctypes.windll.kernel32.GetTickCount64() / 3600000.0, 1)
        except Exception:
            return None
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            return round(float(f.read().split()[0]) / 3600.0, 1)
    except OSError:
        return None


def ram_gb():
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return st.ullTotalPhys / (1024**3), st.ullAvailPhys / (1024**3)
    except Exception:
        pass
    try:
        import psutil

        vm = psutil.virtual_memory()
        return vm.total / (1024**3), vm.available / (1024**3)
    except Exception:
        return None


def disks():
    out = []
    for d in DISK_DRIVES:
        try:
            u = shutil.disk_usage(d)
            out.append(
                {
                    "drive": d,
                    "totalGb": round(u.total / (1024**3), 1),
                    "freeGb": round(u.free / (1024**3), 1),
                    "freePct": round(u.free / u.total * 100, 1),
                }
            )
        except OSError:
            continue
    return out


def main():
    ram = ram_gb()
    report = {
        "os": platform.system(),
        "version": platform.version(),
        "arch": platform.machine(),
        "cpu": platform.processor() or os.environ.get("PROCESSOR_IDENTIFIER", "?"),
        "cores": os.cpu_count(),
        "ramTotalGb": round(ram[0], 1) if ram else None,
        "ramFreeGb": round(ram[1], 1) if ram else None,
        "uptimeHours": uptime_hours(),
        "disks": disks(),
        "hostname": platform.node(),
        "user": os.environ.get("USERNAME") or os.environ.get("USER") or "?",
        "python": sys.version.split()[0],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
