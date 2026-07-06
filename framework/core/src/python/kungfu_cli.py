#  SPDX-License-Identifier: Apache-2.0

# Nuitka Settings
###########################################################
# nuitka-project: --standalone
#
# nuitka-project: --assume-yes-for-downloads
# nuitka-project: --prefer-source-code
# nuitka-project: --python-flag=nosite
# nuitka-project: --remove-output
# nuitka-project: --static-libpython=no
#
# nuitka-project: --warn-unusual-code
# nuitka-project: --warn-implicit-exceptions
#
# 科学计算栈(numpy/pandas/scipy/statsmodels/plotly/botocore)不打进冻结运行时：
# 全仓核心路径实测零 import(numpy 仅经 pandas 间接依赖，pandas 原仅 journal.py
# find_sessions 一处，已改为不依赖 DataFrame)。这些包编进冻结体使主二进制膨胀
# ~235M、散落 C 扩展 ~110M。需要重科学能力的场景由 kfx 自带依赖(engage 工具链)另案落地。
# nuitka-project: --nofollow-import-to=numpy
# nuitka-project: --nofollow-import-to=pandas
# nuitka-project: --nofollow-import-to=scipy
# nuitka-project: --nofollow-import-to=statsmodels
# nuitka-project: --nofollow-import-to=plotly
# nuitka-project: --nofollow-import-to=botocore
#
# nuitka-project: --nofollow-import-to=*.distutils
# nuitka-project: --nofollow-import-to=*.tests
# chardet 7.x 随包发 mypyc 编译的 .so（__init__ 同时有 .py/.so），Nuitka 误当源码解析；
# 它只是 requests 的可选字符集探测器，缺失时 requests 回退 charset_normalizer，故不跟随编译。
# nuitka-project: --nofollow-import-to=chardet
#
# `kfc engage` / verify 的开发工具(black/pdm/scons/nuitka/mypy)：这些工具里部分为 mypyc 编译包(.so __init__)，
# Nuitka 4.x 拒绝把 .so 当源码编译；且把 Nuitka/SCons 自身打进冻结 kfc 不合理。bridging 全是函数内
# 懒加载，不影响 kfc 启动与核心命令(journal/trace/rewind/schema/work/kfx)。故运行时
# 冻结版不跟随编译这些 dev 工具；`kfc engage <tool>` 需开发环境另装这些工具（engage 打包另案处理）。
# nuitka-project: --nofollow-import-to=black
# nuitka-project: --nofollow-import-to=mypy
# nuitka-project: --nofollow-import-to=pdm
# nuitka-project: --nofollow-import-to=SCons
# nuitka-project: --nofollow-import-to=scons
# nuitka-project: --nofollow-import-to=nuitka
# nuitka-project: --nofollow-import-to=mypy
#
# nuitka-project: --enable-plugin=pylint-warnings
#
# nuitka-project: --noinclude-pytest-mode=nofollow
# nuitka-project: --noinclude-setuptools-mode=nofollow
# nuitka-project: --nofollow-import-to=distutils
#
# nuitka-project: --no-progress
###########################################################

from kungfu import __main__ as origin

origin.main()
