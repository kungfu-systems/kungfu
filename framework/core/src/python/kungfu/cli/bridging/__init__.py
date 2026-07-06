#  SPDX-License-Identifier: Apache-2.0


def run_module(module_name):
    from importlib.util import find_spec, module_from_spec

    main_spec = find_spec(module_name)
    if not main_spec:
        raise ModuleNotFoundError(f"module {module_name} not found")
    main_module = module_from_spec(main_spec)
    main_loader = main_spec.loader
    assert main_loader is not None  # module_from_spec above requires a loader
    # the concrete loader carries .name at runtime; the Loader protocol doesn't
    main_loader.name = main_module.__name__ = "__main__"  # type: ignore[attr-defined]
    main_loader.exec_module(main_module)


def run_module_main(module_name):
    module_main = f"{module_name}.__main__"
    try:
        run_module(f"kungfu.cli.bridging.{module_main}")
    except ModuleNotFoundError:
        run_module(module_main)
