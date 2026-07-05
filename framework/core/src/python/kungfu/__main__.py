#  SPDX-License-Identifier: Apache-2.0

# Environment Variables
###########################################################
# KF_HOME - base folder for kungfu files
# KF_LOG_LEVEL - logging level
# KF_NO_EXT - disable extensions if set
###########################################################

from kungfu.cli import available, select


def main(**kwargs):
    select(available(), **kwargs)


if __name__ == "__main__":
    main()
