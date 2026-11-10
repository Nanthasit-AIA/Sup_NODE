import logging, time
from coloredlogs import install
from functools import wraps

logger = logging.getLogger(__name__)
logger_format = "%(asctime)s %(hostname)s %(name)s[%(process)d] %(levelname)s %(message)s"
install(level='DEBUG', format=logger_format)

def timeit_log(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        start_time = time.time()
        logger.debug(f"Calling: {func.__name__} args={args}, kwargs={kwargs}")
        result = func(*args, **kwargs)
        duration = time.time() - start_time
        logger.debug(f"Finished: {func.__name__} returned={result} in [Time] {duration:.4f} sec")
        return result
    return wrapper
