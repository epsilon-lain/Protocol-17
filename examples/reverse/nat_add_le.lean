import Lean

theorem nat_add_le (a b c d : Nat) (hab : a ≤ b) (hcd : c ≤ d) :
    a + c ≤ b + d := by
  have left : a + c ≤ b + c := Nat.add_le_add_right hab c
  have right : b + c ≤ b + d := by omega
  exact Nat.le_trans left right

#print axioms nat_add_le
