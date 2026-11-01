import Std

/- An executable model of the greedy loop over exact, scaled natural-number
distances. Candidate order is supplied by the caller (relevance, then path).
This does not model JavaScript floating-point arithmetic or token extraction. -/
namespace Representative

def best (cost : Nat → Nat) (first : Nat) : List Nat → Nat
  | [] => first
  | next :: rest =>
    let winner := best cost next rest
    if cost first ≤ cost winner then first else winner

theorem best_mem (cost : Nat → Nat) (first : Nat) (rest : List Nat) :
    best cost first rest ∈ first :: rest := by
  induction rest generalizing first with
  | nil => simp [best]
  | cons next rest ih =>
    simp only [best]
    split
    · exact List.mem_cons_self
    · exact List.mem_cons_of_mem _ (ih next)

theorem best_le (cost : Nat → Nat) (first : Nat) (rest : List Nat) :
    ∀ candidate ∈ first :: rest, cost (best cost first rest) ≤ cost candidate := by
  induction rest generalizing first with
  | nil => simp [best]
  | cons next rest ih =>
    intro candidate member
    simp only [best]
    split
    · rename_i h
      rcases List.mem_cons.mp member with equal | member
      · subst candidate; exact Nat.le_refl _
      · exact Nat.le_trans h (ih next candidate member)
    · rename_i h
      rcases List.mem_cons.mp member with equal | member
      · subst candidate; omega
      · exact ih next candidate member

def update (distance : Nat → Nat → Nat) (nearest : Nat → Nat)
    (chosen : Nat) : Nat → Nat :=
  fun target => min (nearest target) (distance chosen target)

def total (targets : List Nat) (nearest : Nat → Nat) : Nat :=
  (targets.map nearest).sum

def cost (distance : Nat → Nat → Nat) (targets : List Nat)
    (nearest : Nat → Nat) (candidate : Nat) : Nat :=
  total targets (update distance nearest candidate)

theorem update_total_le (distance : Nat → Nat → Nat) (targets : List Nat)
    (nearest : Nat → Nat) (chosen : Nat) :
    total targets (update distance nearest chosen) ≤ total targets nearest := by
  induction targets with
  | nil => simp [total]
  | cons target targets ih =>
    simp only [total, List.map_cons, List.sum_cons] at *
    have h : update distance nearest chosen target ≤ nearest target := Nat.min_le_left _ _
    omega

def greedy (distance : Nat → Nat → Nat) (targets : List Nat) :
    Nat → List Nat → (Nat → Nat) → List Nat
  | 0, _, _ => []
  | _ + 1, [], _ => []
  | fuel + 1, first :: rest, nearest =>
    let chosen := best (cost distance targets nearest) first rest
    chosen :: greedy distance targets fuel ((first :: rest).erase chosen)
      (update distance nearest chosen)

theorem greedy_length (distance : Nat → Nat → Nat) (targets : List Nat)
    (fuel : Nat) (pool : List Nat) (nearest : Nat → Nat) :
    (greedy distance targets fuel pool nearest).length = min fuel pool.length := by
  induction fuel generalizing pool nearest with
  | zero => simp [greedy]
  | succ fuel ih =>
    cases pool with
    | nil => simp [greedy]
    | cons first rest =>
      simp only [greedy, List.length_cons]
      rw [ih]
      have h := List.length_erase_of_mem (best_mem (cost distance targets nearest) first rest)
      simp only [List.length_cons] at h
      rw [h]
      simp only [Nat.add_sub_cancel]
      omega

theorem greedy_subset (distance : Nat → Nat → Nat) (targets : List Nat)
    (fuel : Nat) (pool : List Nat) (nearest : Nat → Nat) :
    ∀ candidate ∈ greedy distance targets fuel pool nearest, candidate ∈ pool := by
  induction fuel generalizing pool nearest with
  | zero => simp [greedy]
  | succ fuel ih =>
    cases pool with
    | nil => simp [greedy]
    | cons first rest =>
      intro candidate member
      simp only [greedy, List.mem_cons] at member
      rcases member with equal | member
      · subst candidate
        exact best_mem (cost distance targets nearest) first rest
      · exact List.mem_of_mem_erase (ih _ _ candidate member)

theorem greedy_nodup (distance : Nat → Nat → Nat) (targets : List Nat)
    (fuel : Nat) (pool : List Nat) (nearest : Nat → Nat) (unique : pool.Nodup) :
    (greedy distance targets fuel pool nearest).Nodup := by
  induction fuel generalizing pool nearest with
  | zero => simp [greedy]
  | succ fuel ih =>
    cases pool with
    | nil => simp [greedy]
    | cons first rest =>
      simp only [greedy, List.nodup_cons]
      constructor
      · intro member
        exact unique.not_mem_erase (greedy_subset _ _ _ _ _ _ member)
      · exact ih _ _ (unique.erase _)

/- Match the production fast path: return the already sorted pool when the
budget covers it, rather than reordering every candidate greedily. -/
def select (distance : Nat → Nat → Nat) (scale budget : Nat) (pool : List Nat) : List Nat :=
  if pool.length ≤ budget then pool
  else greedy distance pool budget pool (fun _ => scale)

theorem select_length (distance : Nat → Nat → Nat) (scale budget : Nat) (pool : List Nat) :
    (select distance scale budget pool).length = min budget pool.length := by
  unfold select
  split
  · omega
  · exact greedy_length _ _ _ _ _

theorem select_subset (distance : Nat → Nat → Nat) (scale budget : Nat) (pool : List Nat) :
    ∀ candidate ∈ select distance scale budget pool, candidate ∈ pool := by
  unfold select
  split
  · intro candidate member; exact member
  · exact greedy_subset _ _ _ _ _

theorem select_nodup (distance : Nat → Nat → Nat) (scale budget : Nat) (pool : List Nat)
    (unique : pool.Nodup) : (select distance scale budget pool).Nodup := by
  unfold select
  split
  · exact unique
  · exact greedy_nodup _ _ _ _ _ unique

/- A finite matrix adapter used by the differential test runner. -/
def run (matrix : List (List Nat)) (scale budget : Nat) : List Nat :=
  select (fun i j => ((matrix[i]?).getD [])[j]?.getD 0)
    scale budget (List.range matrix.length)

end Representative

#print axioms Representative.best_le
#print axioms Representative.update_total_le
#print axioms Representative.select_length
#print axioms Representative.select_subset
#print axioms Representative.select_nodup
