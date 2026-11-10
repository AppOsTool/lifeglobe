"""Command line: `lifeglobe` (or `python -m lifeglobe`) starts the map on this computer and opens the browser."""
import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__
from .server import serve
from .settings import Settings
from .storage import Store, data_dir


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="lifeglobe", description="A private, local map of how your life fits together.")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--data-dir", help="where your map is kept (default: ~/.lifeglobe)")
    p.add_argument("--no-browser", action="store_true", help="do not open the browser")
    p.add_argument("--version", action="version", version=__version__)
    a = p.parse_args(argv)

    if a.data_dir:
        os.environ["LIFEGLOBE_HOME"] = a.data_dir
    root = Path(data_dir())
    srv = serve(Store(root), Settings(root), "127.0.0.1", a.port)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"lifeglobe {__version__} — your map: {url}")
    print(f"data: {root}  (stays on this computer)")
    print("Ctrl+C to stop")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        sys.exit(0)


if __name__ == "__main__":
    main()
