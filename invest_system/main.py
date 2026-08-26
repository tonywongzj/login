import argparse
import logging
import time

from collector import collect_once
from config import FETCH_INTERVAL_SECONDS
from db import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def main():
    parser = argparse.ArgumentParser(description="实时行情采集")
    parser.add_argument("--once", action="store_true", help="只采集一次后退出")
    args = parser.parse_args()

    init_db()

    if args.once:
        collect_once()
        return

    while True:
        try:
            collect_once()
        except Exception:
            logging.exception("采集失败")
        time.sleep(FETCH_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
