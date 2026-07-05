#  SPDX-License-Identifier: Apache-2.0


def main():
    from black.__main__ import patched_main

    patched_main()
