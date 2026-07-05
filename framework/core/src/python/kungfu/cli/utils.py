import sys
import importlib


def safe_import(m):
    if m not in sys.modules:
        return importlib.import_module(m)
    else:
        raise ImportError("module {} with the same name is already imported".format(m))
