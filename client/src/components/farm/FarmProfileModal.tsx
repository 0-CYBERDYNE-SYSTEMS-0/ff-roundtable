import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Wheat, MapPin, Droplets, Thermometer } from "lucide-react";

interface FarmProfileData {
  farmName: string;
  location: string;
  lat: string;
  lng: string;
  acres: string;
  crops: string;
  soilType: string;
  waterSource: string;
  climateZone: string;
  hardinessZone: string;
}

interface FarmProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY_FORM: FarmProfileData = {
  farmName: "",
  location: "",
  lat: "",
  lng: "",
  acres: "",
  crops: "",
  soilType: "",
  waterSource: "",
  climateZone: "",
  hardinessZone: "",
};

export default function FarmProfileModal({ isOpen, onClose, onSaved }: FarmProfileModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<FarmProfileData>(EMPTY_FORM);

  useEffect(() => {
    // Fetch existing profile on mount
    async function loadProfile() {
      setError("");
      setDirty(false);
      try {
        const res = await fetch("/api/protected/farm-profile", { credentials: "include" });
        if (res.ok) {
          const payload = await res.json();
          const profile = payload?.profile ?? payload;
          if (profile) {
            setForm({
              farmName: profile.farmName || "",
              location: profile.location || "",
              lat: profile.lat || "",
              lng: profile.lng || "",
              acres: profile.acres ? String(profile.acres) : "",
              crops: (profile.crops || []).join(", "),
              soilType: profile.soilType || "",
              waterSource: profile.waterSource || "",
              climateZone: profile.climateZone || "",
              hardinessZone: profile.hardinessZone || "",
            });
          }
        }
      } catch {}
    }
    if (isOpen) loadProfile();
  }, [isOpen]);

  const handleChange = (field: keyof FarmProfileData, value: string | number) => {
    setDirty(true);
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  // Don't throw away a half-filled form (this modal auto-opens during
  // onboarding) without asking, and never close mid-save.
  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) {
      return;
    }
    onClose();
  };

  const handleSave = async () => {
    if (!form.farmName.trim()) {
      setError("Farm name is required.");
      return;
    }
    setSaving(true);
    setError("");

    try {
      const cropsArray = form.crops
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      const res = await fetch("/api/protected/farm-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          farmName: form.farmName,
          location: form.location,
          lat: form.lat || null,
          lng: form.lng || null,
          acres: Math.max(0, Math.floor(Number(form.acres) || 0)),
          crops: cropsArray,
          soilType: form.soilType,
          waterSource: form.waterSource,
          climateZone: form.climateZone,
          hardinessZone: form.hardinessZone,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.message || "Failed to save farm profile");
      }

      setDirty(false);
      onSaved();
    } catch (err: any) {
      setError(err.message || "Failed to save farm profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && requestClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-farm-blue flex items-center gap-2">
            <Wheat className="h-5 w-5" />
            {form.farmName ? "Edit Farm Profile" : "Welcome! Tell Us About Your Farm"}
          </DialogTitle>
          <DialogDescription className="text-neutral-600">
            {form.farmName
              ? "Update your farm details. Experts will tailor their advice to your operation."
              : "Your AI experts need to know your farm to give personalized advice. Fill in what you can — even just location and crops makes a huge difference."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 pt-4">
          <div className="col-span-2">
            <Label htmlFor="farmName">Farm Name</Label>
            <Input
              id="farmName"
              placeholder="Green Acres Farm"
              required
              value={form.farmName}
              onChange={(e) => handleChange("farmName", e.target.value)}
            />
          </div>

          <div className="col-span-2">
            <Label htmlFor="location" className="flex items-center gap-1">
              <MapPin className="h-3 w-3" /> Location
            </Label>
            <Input
              id="location"
              placeholder="Boise, Idaho"
              value={form.location}
              onChange={(e) => handleChange("location", e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="lat">Latitude (optional)</Label>
            <Input
              id="lat"
              type="number"
              step="any"
              placeholder="43.6150"
              value={form.lat}
              onChange={(e) => handleChange("lat", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lng">Longitude (optional)</Label>
            <Input
              id="lng"
              type="number"
              step="any"
              placeholder="-116.2023"
              value={form.lng}
              onChange={(e) => handleChange("lng", e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="acres">Total Acres</Label>
            <Input
              id="acres"
              type="number"
              min="0"
              step="1"
              placeholder="200"
              value={form.acres}
              onChange={(e) => handleChange("acres", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="hardinessZone">USDA Hardiness Zone</Label>
            <Input
              id="hardinessZone"
              placeholder="6b"
              value={form.hardinessZone}
              onChange={(e) => handleChange("hardinessZone", e.target.value)}
            />
          </div>

          <div className="col-span-2">
            <Label htmlFor="crops">Crops (comma-separated)</Label>
            <Input
              id="crops"
              placeholder="corn, soybeans, wheat, alfalfa"
              value={form.crops}
              onChange={(e) => handleChange("crops", e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="soilType" className="flex items-center gap-1">
              <Wheat className="h-3 w-3" /> Soil Type
            </Label>
            <Input
              id="soilType"
              placeholder="Clay loam"
              value={form.soilType}
              onChange={(e) => handleChange("soilType", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="waterSource" className="flex items-center gap-1">
              <Droplets className="h-3 w-3" /> Water Source
            </Label>
            <Input
              id="waterSource"
              placeholder="Irrigation wells + rainfall"
              value={form.waterSource}
              onChange={(e) => handleChange("waterSource", e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="climateZone" className="flex items-center gap-1">
              <Thermometer className="h-3 w-3" /> Climate Zone
            </Label>
            <Input
              id="climateZone"
              placeholder="Semi-arid / Continental"
              value={form.climateZone}
              onChange={(e) => handleChange("climateZone", e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <p className="text-xs text-neutral-500">
              Lat/lng are used for real-time weather data (OpenWeatherMap).
            </p>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          {form.farmName && (
            <Button variant="outline" onClick={requestClose} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-farm-green hover:bg-farm-dark-green text-white"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving...
              </>
            ) : (
              "Save Farm Profile"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
