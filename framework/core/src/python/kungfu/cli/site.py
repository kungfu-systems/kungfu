#  SPDX-License-Identifier: Apache-2.0

import sys
import os
import builtins
import _sitebuiltins
import io

# Prefixes for site-packages; add additional prefixes like /usr/local here
PREFIXES = [sys.prefix, sys.exec_prefix]
# Enable per user site-packages directory
# set it to False to disable the feature or True to force the feature
ENABLE_USER_SITE = None

# for distutils.commands.install
# These values are initialized by the getuserbase() and getusersitepackages()
# functions, through the main() function when Python starts.
USER_SITE = None
USER_BASE = None


def makepath(*paths):
    dir = os.path.join(*paths)
    try:
        dir = os.path.abspath(dir)
    except OSError:
        pass
    return dir, os.path.normcase(dir)


def abs_paths():
    """Set all module __file__ and __cached__ attributes to an absolute path"""
    for m in set(sys.modules.values()):
        if getattr(getattr(m, "__loader__", None), "__module__", None) not in (
            "_frozen_importlib",
            "_frozen_importlib_external",
        ):
            continue  # don't mess with a PEP 302-supplied __file__
        try:
            # __file__ may be None/absent; the except below is the guard by design
            m.__file__ = os.path.abspath(m.__file__)  # type: ignore[type-var]
        except (AttributeError, OSError, TypeError):
            pass
        try:
            m.__cached__ = os.path.abspath(m.__cached__)
        except (AttributeError, OSError, TypeError):
            pass


def removeduppaths():
    """Remove duplicate entries from sys.path along with making them
    absolute"""
    # This ensures that the initial path provided by the interpreter contains
    # only absolute pathnames, even if we're running from the build directory.
    L = []
    known_paths = set()
    for dir in sys.path:
        # Filter out duplicate paths (on case-insensitive file systems also
        # if they only differ in case); turn relative paths into absolute
        # paths.
        dir, dircase = makepath(dir)
        if dircase not in known_paths:
            L.append(dir)
            known_paths.add(dircase)
    sys.path[:] = L
    return known_paths


def _init_pathinfo():
    """Return a set containing all existing file system items from sys.path."""
    d = set()
    for item in sys.path:
        try:
            if os.path.exists(item):
                _, itemcase = makepath(item)
                d.add(itemcase)
        except TypeError:
            continue
    return d


def addpackage(sitedir, name, known_paths):
    """Process a .pth file within the site-packages directory:
    For each line in the file, either combine it with sitedir to a path
    and add that to known_paths, or execute it if it starts with 'import '.
    """
    if known_paths is None:
        known_paths = _init_pathinfo()
        reset = True
    else:
        reset = False
    fullname = os.path.join(sitedir, name)
    try:
        f = io.TextIOWrapper(io.open_code(fullname))
    except OSError:
        return
    with f:
        for n, line in enumerate(f):
            if line.startswith("#"):
                continue
            try:
                if line.startswith(("import ", "import\t")):
                    exec(line)
                    continue
                line = line.rstrip()
                dir, dircase = makepath(sitedir, line)
                if dircase not in known_paths and os.path.exists(dir):
                    sys.path.append(dir)
                    known_paths.add(dircase)
            except Exception:
                print(
                    "Error processing line {:d} of {}:\n".format(n + 1, fullname),
                    file=sys.stderr,
                )
                import traceback

                for record in traceback.format_exception(*sys.exc_info()):
                    for line in record.splitlines():
                        print("  " + line, file=sys.stderr)
                print("\nRemainder of file ignored", file=sys.stderr)
                break
    if reset:
        known_paths = None
    return known_paths


def addsitedir(sitedir, known_paths=None):
    """Add 'sitedir' argument to sys.path if missing and handle .pth files in
    'sitedir'"""
    if known_paths is None:
        known_paths = _init_pathinfo()
        reset = True
    else:
        reset = False
    sitedir, sitedircase = makepath(sitedir)
    if sitedircase not in known_paths:
        sys.path.append(sitedir)  # Add path component
        known_paths.add(sitedircase)
    try:
        names = os.listdir(sitedir)
    except OSError:
        return
    names = [name for name in names if name.endswith(".pth")]
    for name in sorted(names):
        addpackage(sitedir, name, known_paths)
    if reset:
        known_paths = None
    return known_paths


def check_enableusersite():
    """Check if user site directory is safe for inclusion

    The function tests for the command line flag (including environment var),
    process uid/gid equal to effective uid/gid.

    None: Disabled for security reasons
    False: Disabled by user (command line option)
    True: Safe and enabled
    """
    if sys.flags.no_user_site:
        return False

    if hasattr(os, "getuid") and hasattr(os, "geteuid"):
        # check process uid == effective uid
        if os.geteuid() != os.getuid():
            return None
    if hasattr(os, "getgid") and hasattr(os, "getegid"):
        # check process gid == effective gid
        if os.getegid() != os.getgid():
            return None

    return True


# NOTE: sysconfig and it's dependencies are relatively large but site module
# needs very limited part of them.
# To speedup startup time, we have copy of them.
#
# See https://bugs.python.org/issue29585


# Copy of sysconfig._getuserbase()
def _getuserbase():
    env_base = os.environ.get("PYTHONUSERBASE", None)
    if env_base:
        return env_base

    def joinuser(*args):
        return os.path.expanduser(os.path.join(*args))

    if os.name == "nt":
        base = os.environ.get("APPDATA") or "~"
        return joinuser(base, "Python")

    if sys.platform == "darwin" and sys._framework:
        return joinuser("~", "Library", sys._framework, "%d.%d" % sys.version_info[:2])

    return joinuser("~", ".local")


# Same to sysconfig.get_path('purelib', os.name+'_user')
def _get_path(userbase):
    version = sys.version_info

    if os.name == "nt":
        return f"{userbase}\\Python{version[0]}{version[1]}\\site-packages"

    if sys.platform == "darwin" and sys._framework:
        return f"{userbase}/lib/python/site-packages"

    return f"{userbase}/lib/python{version[0]}.{version[1]}/site-packages"


def getuserbase():
    """Returns the `user base` directory path.

    The `user base` directory can be used to store data. If the global
    variable ``USER_BASE`` is not initialized yet, this function will also set
    it.
    """
    global USER_BASE
    if USER_BASE is None:
        USER_BASE = _getuserbase()
    return USER_BASE


def getusersitepackages():
    """Returns the user-specific site-packages directory path.

    If the global variable ``USER_SITE`` is not initialized yet, this
    function will also set it.
    """
    global USER_SITE
    userbase = getuserbase()  # this will also set USER_BASE

    if USER_SITE is None:
        USER_SITE = _get_path(userbase)

    return USER_SITE


def addusersitepackages(known_paths):
    """Add a per user site-package to sys.path

    Each user has its own python directory with site-packages in the
    home directory.
    """
    # get the per user site-package path
    # this call will also make sure USER_BASE and USER_SITE are set
    user_site = getusersitepackages()

    if ENABLE_USER_SITE and os.path.isdir(user_site):
        addsitedir(user_site, known_paths)
    return known_paths


def getsitepackages(prefixes=None):
    """Returns a list containing all global site-packages directories.

    For each directory present in ``prefixes`` (or the global ``PREFIXES``),
    this function will find its `site-packages` subdirectory depending on the
    system environment, and will return a list of full paths.
    """
    sitepackages = []
    seen = set()

    if prefixes is None:
        prefixes = PREFIXES

    for prefix in prefixes:
        if not prefix or prefix in seen:
            continue
        seen.add(prefix)

        libdirs = [sys.platlibdir]
        if sys.platlibdir != "lib":
            libdirs.append("lib")

        if os.sep == "/":
            for libdir in libdirs:
                path = os.path.join(
                    prefix,
                    libdir,
                    "python%d.%d" % sys.version_info[:2],
                    "site-packages",
                )
                sitepackages.append(path)
        else:
            sitepackages.append(prefix)

            for libdir in libdirs:
                path = os.path.join(prefix, libdir, "site-packages")
                sitepackages.append(path)
    return sitepackages


def addsitepackages(known_paths, prefixes=None):
    """Add site-packages to sys.path"""
    for sitedir in getsitepackages(prefixes):
        if os.path.isdir(sitedir):
            addsitedir(sitedir, known_paths)

    return known_paths


def setquit():
    """Define new builtins 'quit' and 'exit'.

    These are objects which make the interpreter exit when called.
    The repr of each object contains a hint at how it works.

    """
    if os.sep == "\\":
        eof = "Ctrl-Z plus Return"
    else:
        eof = "Ctrl-D (i.e. EOF)"

    builtins.quit = _sitebuiltins.Quitter("quit", eof)
    builtins.exit = _sitebuiltins.Quitter("exit", eof)


def setcopyright():
    """Set 'copyright' and 'credits' in builtins"""
    builtins.copyright = _sitebuiltins._Printer("copyright", sys.copyright)
    if sys.platform[:4] == "java":
        builtins.credits = _sitebuiltins._Printer(
            "credits", "Jython is maintained by the Jython developers (www.jython.org)."
        )
    else:
        builtins.credits = _sitebuiltins._Printer(
            "credits",
            """\
    Thanks to CWI, CNRI, BeOpen.com, Zope Corporation and a cast of thousands
    for supporting Python development.  See www.python.org for more information.""",
        )
    files, dirs = [], []
    # Not all modules are required to have a __file__ attribute.  See
    # PEP 420 for more details.
    if hasattr(os, "__file__"):
        here = os.path.dirname(os.__file__)
        files.extend(["LICENSE.txt", "LICENSE"])
        dirs.extend([os.path.join(here, os.pardir), here, os.curdir])
    builtins.license = _sitebuiltins._Printer(
        "license", "See https://www.python.org/psf/license/", files, dirs
    )


def sethelper():
    builtins.help = _sitebuiltins._Helper()


def enablerlcompleter():
    """Enable default readline configuration on interactive prompts, by
    registering a sys.__interactivehook__.

    If the readline module can be imported, the hook will set the Tab key
    as completion key and register ~/.python_history as history file.
    This can be overridden in the sitecustomize or usercustomize module,
    or in a PYTHONSTARTUP file.
    """

    def register_readline():
        import atexit

        try:
            import readline
            import rlcompleter  # noqa: F401  (readline 补全副作用)
        except ImportError:
            return

        # Reading the initialization (config) file may not be enough to set a
        # completion key, so we set one first and then read the file.
        readline_doc = getattr(readline, "__doc__", "")
        if readline_doc is not None and "libedit" in readline_doc:
            readline.parse_and_bind("bind ^I rl_complete")
        else:
            readline.parse_and_bind("tab: complete")

        try:
            readline.read_init_file()
        except OSError:
            # An OSError here could have many causes, but the most likely one
            # is that there's no .inputrc file (or .editrc file in the case of
            # Mac OS X + libedit) in the expected location.  In that case, we
            # want to ignore the exception.
            pass

        if readline.get_current_history_length() == 0:
            # If no history was loaded, default to .python_history.
            # The guard is necessary to avoid doubling history size at
            # each interpreter exit when readline was already configured
            # through a PYTHONSTARTUP hook, see:
            # http://bugs.python.org/issue5845#msg198636
            history = os.path.join(os.path.expanduser("~"), ".python_history")
            try:
                readline.read_history_file(history)
            except OSError:
                pass

            def write_history():
                try:
                    readline.write_history_file(history)
                except OSError:
                    # bpo-19891, bpo-41193: Home directory does not exist
                    # or is not writable, or the filesystem is read-only.
                    pass

            atexit.register(write_history)

    sys.__interactivehook__ = register_readline


def venv(known_paths):
    global PREFIXES, ENABLE_USER_SITE

    env = os.environ
    if sys.platform == "darwin" and "__PYVENV_LAUNCHER__" in env:
        executable = sys._base_executable = os.environ["__PYVENV_LAUNCHER__"]
    else:
        executable = sys.executable
    exe_dir, _ = os.path.split(os.path.abspath(executable))
    site_prefix = os.path.dirname(exe_dir)
    sys._home = None
    conf_basename = "pyvenv.cfg"
    candidate_confs = [
        conffile
        for conffile in (
            os.path.join(exe_dir, conf_basename),
            os.path.join(site_prefix, conf_basename),
        )
        if os.path.isfile(conffile)
    ]

    if candidate_confs:
        virtual_conf = candidate_confs[0]
        system_site = "true"
        # Issue 25185: Use UTF-8, as that's what the venv module uses when
        # writing the file.
        with open(virtual_conf, encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    key, _, value = line.partition("=")
                    key = key.strip().lower()
                    value = value.strip()
                    if key == "include-system-site-packages":
                        system_site = value.lower()
                    elif key == "home":
                        sys._home = value

        sys.prefix = sys.exec_prefix = site_prefix

        # Doing this here ensures venv takes precedence over user-site
        addsitepackages(known_paths, [sys.prefix])

        # addsitepackages will process site_prefix again if its in PREFIXES,
        # but that's ok; known_paths will prevent anything being added twice
        if system_site == "true":
            PREFIXES.insert(0, sys.prefix)
        else:
            PREFIXES = [sys.prefix]
            ENABLE_USER_SITE = False

    return known_paths


def execsitecustomize():
    """Run custom site specific code, if available."""
    try:
        try:
            import sitecustomize  # noqa: F401  (site 定制副作用)
        except ImportError as exc:
            if exc.name == "sitecustomize":
                pass
            else:
                raise
    except Exception as err:
        if sys.flags.verbose:
            sys.excepthook(*sys.exc_info())
        else:
            sys.stderr.write(
                "Error in sitecustomize; set PYTHONVERBOSE for traceback:\n"
                "%s: %s\n" % (err.__class__.__name__, err)
            )


def execusercustomize():
    """Run custom user specific code, if available."""
    try:
        try:
            import usercustomize  # noqa: F401  (user 定制副作用)
        except ImportError as exc:
            if exc.name == "usercustomize":
                pass
            else:
                raise
    except Exception as err:
        if sys.flags.verbose:
            sys.excepthook(*sys.exc_info())
        else:
            sys.stderr.write(
                "Error in usercustomize; set PYTHONVERBOSE for traceback:\n"
                "%s: %s\n" % (err.__class__.__name__, err)
            )


def get_pypackages_path(root_dir, maxdepth=5):
    def find_pypackage(path, version):
        if not os.path.exists(path):
            return None

        packages_name = "__pypackages__/{}/lib".format(version)
        for _ in range(maxdepth):
            if os.path.exists(os.path.join(path, packages_name)):
                return os.path.join(path, packages_name)
            if os.path.dirname(path) == path:
                # Root path is reached
                break
            path = os.path.dirname(path)
        return None

    if "PEP582_PACKAGES" in os.environ:
        return os.path.join(os.environ["PEP582_PACKAGES"], "lib")
    find_paths = [root_dir]
    version = bare_version = ".".join(map(str, sys.version_info[:2]))
    if os.name == "nt" and sys.maxsize <= ((2) ** 32):
        version += "-32"

    if getattr(sys, "argv", None):
        script_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        find_paths.insert(0, script_dir)

    for path in find_paths:
        result = find_pypackage(path, version)
        if result:
            return result

    if bare_version != version:
        for path in find_paths:
            result = find_pypackage(path, bare_version)
            if result:
                return result


def setup(root_dir=os.getcwd()):
    self_path = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    sys.path[:] = [path for path in sys.path if os.path.normcase(path) != self_path]

    libpath = get_pypackages_path(root_dir)
    if not libpath:
        return

    # First, drop site related paths.
    original_sys_path = sys.path[:]
    known_paths: set[str] = set()
    addusersitepackages(known_paths)
    addsitepackages(known_paths)
    known_paths = {os.path.normcase(path) for path in known_paths}
    original_sys_path = [
        path for path in original_sys_path if os.path.normcase(path) not in known_paths
    ]
    sys.path[:] = original_sys_path

    # Second, add lib directories, ensuring .pth file are processed.
    addsitedir(libpath)
    if not os.environ.pop("NO_SITE_PACKAGES", None):
        # Then add the removed path to the tail of the paths
        known_paths.clear()
        addusersitepackages(known_paths)
        addsitepackages(known_paths)
