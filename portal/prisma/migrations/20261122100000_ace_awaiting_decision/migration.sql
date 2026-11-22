-- ACE clients whose prepaid time ended with no Continuing/Ending decision yet.
ALTER TYPE "ClientStatus" ADD VALUE 'ACE_AWAITING_DECISION' BEFORE 'ENDED';
