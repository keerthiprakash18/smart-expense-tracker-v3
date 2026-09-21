"""Backward-compatible imports for older code.

Authentication/profile views now live in expenses.views so there is a single API
implementation. The old PhoneOTP model was removed by migration 0005, therefore
this module intentionally contains no simulated OTP flow.
"""

from .views import ChangePasswordView, RegisterView, UserProfileView

__all__ = ["RegisterView", "UserProfileView", "ChangePasswordView"]
