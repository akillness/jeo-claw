# Spec: HITL CAPTCHA Resolver

## Goal
Establish a Human-in-the-Loop (HITL) flow for resolving CAPTCHAs or login challenges during web automation.

## Flow
1. **Detection**:  detects an  or login modal.
2. **Alert**: Orchestrator sends a message to the Discord approval channel with a screenshot of the challenge.
3. **Wait**: Automation pauses.
4. **Action**: User solves the challenge manually or provides instructions.
5. **Resume**: Automation continues after user confirmation.
