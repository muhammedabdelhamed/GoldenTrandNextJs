// components/payment/SelectWalletType.tsx
import React from "react";
import { Icon } from "@iconify/react";
import Button from "@/components/elements/base/button/Button";
import RadioHeadless from "@/components/elements/form/radio/RadioHeadless";
import { useTranslation } from "next-i18next";

export const SelectWalletType = ({
  walletTypes,
  selectedWalletType,
  setSelectedWalletType,
  onNext,
}) => {
  const { t } = useTranslation();

  return (
    <div>
      <div className="mb-12 space-y-1 text-center font-sans">
        <h2 className="text-2xl font-light text-muted-800 dark:text-muted-100">
          {t("Select a Wallet Type")}
        </h2>
        <p className="text-sm text-muted-400">
          {t("Pick one of the following wallet types to continue")}
        </p>
      </div>

      <div className="mx-auto mb-4 w-full max-w-lg rounded-sm px-8 pb-8">
        <div className={`grid gap-4`}>
          {walletTypes.map((walletType) => (
            <RadioHeadless
              key={walletType.value}
              name="walletType"
              checked={selectedWalletType.value === walletType.value}
              onChange={() => setSelectedWalletType(walletType)}
            >
              <div
                className={`flex items-center justify-between p-4 bg-white dark:bg-muted-800 rounded-md border ${
                  selectedWalletType.value === walletType.value
                    ? "border-success-500"
                    : "border-muted-200 dark:border-muted-800"
                }`}
              >
                <div className="flex items-center space-x-4">
                  <h5 className="text-lg font-medium text-muted-800 dark:text-muted-100">
                    {t(walletType.label)}
                  </h5>
                </div>
                <div className="flex items-center">
                  {selectedWalletType.value === walletType.value && (
                    <Icon
                      icon="ph:check-circle-duotone"
                      className="h-6 w-6 text-success-500"
                    />
                  )}
                </div>
              </div>
            </RadioHeadless>
          ))}
        </div>

        <div className="mt-6">
          <Button
            type="button"
            color="primary"
            size="lg"
            className="w-full"
            onClick={onNext}
            disabled={selectedWalletType.value === ""}
          >
            {t("Continue")}
            <Icon icon="mdi:chevron-right" className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
};
