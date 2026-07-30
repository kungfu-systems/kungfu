#  SPDX-License-Identifier: Apache-2.0

import logging
from typing import Any

import kungfu

yjj = kungfu.__binding__.runtime

LOG_LEVELS = {
    "trace": logging.DEBUG,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}

SPDLOG_LOG_LEVELS = {
    logging.DEBUG: 1,
    logging.INFO: 2,
    logging.WARNING: 3,
    logging.ERROR: 4,
    logging.CRITICAL: 5,
}


class SpdlogHandler(logging.StreamHandler[Any]):
    def emit(self, record):
        yjj.emit_log(
            record.filename,
            record.lineno,
            record.funcName,
            record.name,
            SPDLOG_LOG_LEVELS[record.levelno],
            record.msg,
        )


def create_logger(name, level, location=None):
    if location is not None:
        yjj.setup_log(location, name)
    logger = logging.getLogger(name)
    logger.addHandler(SpdlogHandler())
    logger.setLevel(LOG_LEVELS[level])
    return logger


def find_logger(location, level="info"):
    logger = logging.getLogger(location.name)
    if logger.hasHandlers():
        return logger
    return create_logger(location.name, level, location)
