"""Run EAS backend server via ``python -m eas``."""

import uvicorn


def main() -> None:
    uvicorn.run("eas.api.main:app", host="0.0.0.0", port=8001)


if __name__ == "__main__":
    main()
