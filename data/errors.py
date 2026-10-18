"""Errors raised by live data sources before the fake fallback."""


class DataSourceError(Exception):
    """A live hazard, weather, or routing source failed.

    Attributes:
        message (str): Why the live call could not be used.
    """

    def __init__(self, message):
        """Store the failure reason.

        Args:
            message (str): Why the live call could not be used.
        """
        self.message = message
        super().__init__(message)
