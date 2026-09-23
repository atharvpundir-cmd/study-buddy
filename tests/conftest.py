import os
import sys
from pathlib import Path

os.environ["STUDY_BUDDY_DEMO"] = "1"
os.environ["STUDY_BUDDY_RATE_LIMIT"] = "0"
os.environ.pop("STUDY_BUDDY_ACCESS_CODE", None)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
